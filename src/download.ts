import { $ } from 'bun'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const TMP_DIR = 'tmp'

export async function downloadAndConvert(opencastUrl: string, lectureId: string): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true })

  const mp4Path = `${TMP_DIR}/${lectureId}.mp4`
  const opusPath = `${TMP_DIR}/${lectureId}.opus`

  // Download MP4 (stream to disk — avoid buffering entire file in RAM)
  console.log(`[download] Fetching: ${opencastUrl}`)
  const response = await fetch(opencastUrl)
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`)

  if (response.body != null)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(mp4Path))
  else await Bun.write(mp4Path, new Uint8Array(await response.arrayBuffer()))

  console.log(`[download] Saved MP4: ${mp4Path}`)

  // Convert to opus @ 32kbps (keeps 90min lectures under 25MB)
  console.log(`[download] Converting to opus...`)
  const result = await $`ffmpeg -y -i ${mp4Path} -vn -c:a libopus -b:a 32k ${opusPath}`.quiet()
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg conversion failed: ${result.stderr.toString()}`)
  }

  // Clean up MP4 to save disk
  await $`rm -f ${mp4Path}`.quiet()

  const stat = Bun.file(opusPath)
  const sizeMB = (await stat.exists()) ? (stat.size ?? 0) / (1024 * 1024) : 0
  console.log(`[download] Opus ready: ${opusPath} (${sizeMB.toFixed(1)} MB)`)

  return opusPath
}

export async function getAudioDuration(audioPath: string): Promise<number> {
  const result = await $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${audioPath}`.quiet()
  const duration = parseFloat(result.stdout.toString().trim())
  if (isNaN(duration)) throw new Error(`Could not determine duration of ${audioPath}`)
  return duration
}

export async function chunkOnSilence(audioPath: string, maxSizeMB = 24): Promise<string[]> {
  const file = Bun.file(audioPath)
  const sizeMB = (file.size ?? 0) / (1024 * 1024)
  if (sizeMB <= maxSizeMB) return [audioPath]

  console.log(`[download] File ${sizeMB.toFixed(1)}MB exceeds ${maxSizeMB}MB, chunking on silence...`)
  await mkdir(`${TMP_DIR}/chunks`, { recursive: true })

  const basename = audioPath.replace(/.*\//, '').replace(/\.[^.]+$/, '')

  // Split on silence: min 0.5s silence, -30dB threshold
  const result = await $`ffmpeg -y -i ${audioPath} -af silencedetect=noise=-30dB:d=0.5 -f null -`.quiet()
  const stderr = result.stderr.toString()

  const silenceEnds = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]))

  if (silenceEnds.length === 0) {
    // No silence detected, split by time
    const duration = await getAudioDuration(audioPath)
    const numChunks = Math.ceil(sizeMB / maxSizeMB)
    const chunkDuration = duration / numChunks
    const chunks: string[] = []

    for (let i = 0; i < numChunks; i++) {
      const chunkPath = `${TMP_DIR}/chunks/${basename}_${i}.opus`
      const start = i * chunkDuration
      await $`ffmpeg -y -i ${audioPath} -ss ${start} -t ${chunkDuration} -c:a libopus -b:a 32k ${chunkPath}`.quiet()
      chunks.push(chunkPath)
    }
    return chunks
  }

  // Split at silence boundaries that produce chunks under maxSizeMB
  const duration = await getAudioDuration(audioPath)
  const targetChunkDuration = (duration * maxSizeMB) / sizeMB
  const chunks: string[] = []
  let lastSplit = 0
  let chunkIdx = 0

  for (const silenceEnd of silenceEnds) {
    if (silenceEnd - lastSplit >= targetChunkDuration) {
      const chunkPath = `${TMP_DIR}/chunks/${basename}_${chunkIdx}.opus`
      await $`ffmpeg -y -i ${audioPath} -ss ${lastSplit} -to ${silenceEnd} -c:a libopus -b:a 32k ${chunkPath}`.quiet()
      chunks.push(chunkPath)
      lastSplit = silenceEnd
      chunkIdx++
    }
  }

  // Final chunk
  if (lastSplit < duration) {
    const chunkPath = `${TMP_DIR}/chunks/${basename}_${chunkIdx}.opus`
    await $`ffmpeg -y -i ${audioPath} -ss ${lastSplit} -c:a libopus -b:a 32k ${chunkPath}`.quiet()
    chunks.push(chunkPath)
  }

  console.log(`[download] Split into ${chunks.length} chunks`)
  return chunks
}

export async function cleanup(lectureId: string): Promise<void> {
  /** Avoid Bun `$` globs: they error with "no matches found" when the pattern matches nothing. */
  for (const ext of ['mp4', 'opus']) {
    await unlink(path.join(TMP_DIR, `${lectureId}.${ext}`)).catch(() => {})
  }
  const chunkDir = path.join(TMP_DIR, 'chunks')
  try {
    const names = await readdir(chunkDir)
    await Promise.all(
      names
        .filter((n) => n.startsWith(`${lectureId}_`))
        .map((n) => unlink(path.join(chunkDir, n)).catch(() => {})),
    )
  } catch {
    //
  }
}

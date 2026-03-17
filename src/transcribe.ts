/**
 * Local voice transcription using faster-whisper.
 * Transcribes an audio file and returns the transcript text.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'base';
const WHISPER_DEVICE = process.env.WHISPER_DEVICE ?? 'cpu';
const WHISPER_COMPUTE = process.env.WHISPER_COMPUTE_TYPE ?? 'int8';

const PYTHON_SCRIPT = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[1], device=sys.argv[2], compute_type=sys.argv[3])
segments, _ = model.transcribe(sys.argv[4], beam_size=5)
print(' '.join(s.text.strip() for s in segments))
`.trim();

export async function transcribeAudio(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', PYTHON_SCRIPT, WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE, filePath],
      { timeout: 60000 },
    );
    const transcript = stdout.trim();
    logger.info({ filePath, transcript }, 'Voice transcribed');
    return transcript || null;
  } catch (err) {
    logger.warn({ filePath, err }, 'faster-whisper transcription failed');
    return null;
  }
}

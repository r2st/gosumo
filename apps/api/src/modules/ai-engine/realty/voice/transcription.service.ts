import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChannelType,
  ExternalServiceError,
  type GoSumoErrorOptions,
} from '@gosumo/shared';
import { ChannelAdapterService } from '../../../channel-adapter/channel-adapter.service';

/**
 * Thrown when audio cannot be transcribed (no key, download/STT failure).
 *
 * Terminal: the caller falls back to asking the buyer to type, so re-running
 * the same download-and-transcribe would only repeat the failure.
 */
export class TranscriptionUnavailableError extends ExternalServiceError {
  constructor(message: string, options: GoSumoErrorOptions & { status?: number } = {}) {
    super('Transcription', message, { ...options, retryable: false });
  }
}

const WHATSAPP_MEDIA_PREFIX = 'whatsapp-media://';

/**
 * TranscriptionService — speech-to-text for WhatsApp voice notes.
 *
 * Downloads the audio (delegating `whatsapp-media://<id>` references to the
 * channel adapter, else fetching an https URL) and posts it to an
 * OpenAI-compatible `/audio/transcriptions` endpoint (OpenRouter, a hosted
 * Whisper, or self-host — configured via `transcription.*`). Built on `fetch`
 * with no provider SDK, so it unit-tests with a mocked `global.fetch`, exactly
 * like the LLM client and the channel adapters.
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly channelAdapter: ChannelAdapterService,
  ) {}

  /**
   * Transcribe a voice note to text. `mediaUrl` is either a `whatsapp-media://`
   * reference or a direct https URL; `mimeType` (e.g. `audio/ogg`) names the
   * uploaded file. Throws {@link TranscriptionUnavailableError} on any failure so
   * the caller can escalate rather than feed the AI an empty string.
   */
  async transcribe(mediaUrl: string, mimeType: string): Promise<string> {
    const apiKey = this.configService.get<string>('transcription.apiKey', '');
    if (!apiKey) {
      throw new TranscriptionUnavailableError('TRANSCRIPTION_API_KEY is not configured');
    }

    const audio = await this.fetchAudio(mediaUrl);
    const url = this.configService.get<string>(
      'transcription.apiUrl',
      'https://api.openai.com/v1/audio/transcriptions',
    );
    const model = this.configService.get<string>('transcription.model', 'whisper-1');

    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([audio], { type: mimeType || 'audio/ogg' }), fileNameFor(mimeType));

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } catch (err) {
      throw new TranscriptionUnavailableError(
        `Transcription request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new TranscriptionUnavailableError(
        `Transcription API error ${response.status}: ${detail}`,
      );
    }

    const json = (await response.json()) as { text?: string };
    const text = (json.text ?? '').trim();
    if (!text) {
      throw new TranscriptionUnavailableError('Transcription returned no text');
    }
    this.logger.debug(`Transcribed voice note (${audio.length} bytes) → ${text.length} chars`);
    return text;
  }

  /** Resolve the audio bytes from a channel-media reference or an https URL. */
  private async fetchAudio(mediaUrl: string): Promise<Buffer> {
    if (mediaUrl.startsWith(WHATSAPP_MEDIA_PREFIX)) {
      const mediaId = mediaUrl.slice(WHATSAPP_MEDIA_PREFIX.length);
      return this.channelAdapter.downloadMedia(ChannelType.WHATSAPP, mediaId);
    }
    let resp: Response;
    try {
      resp = await fetch(mediaUrl);
    } catch (err) {
      throw new TranscriptionUnavailableError(
        `Audio download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      throw new TranscriptionUnavailableError(`Audio download failed: ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }
}

function fileNameFor(mimeType: string): string {
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'voice.mp3';
  if (mimeType.includes('wav')) return 'voice.wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'voice.m4a';
  return 'voice.ogg';
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return `status ${response.status}`;
  }
}

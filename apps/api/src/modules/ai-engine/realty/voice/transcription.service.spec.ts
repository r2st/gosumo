/**
 * TranscriptionService unit tests.
 *
 * Every path through this service is a failure path but one, and they all have
 * to converge on the same outcome: a thrown TranscriptionUnavailableError. The
 * caller escalates the voice note to a human on that error, so a path that
 * returns an empty string instead of throwing would feed the realty AI loop a
 * blank transcript and let it answer a question nobody asked.
 *
 * Driven with a mocked `global.fetch`, the same way the LLM client and the
 * channel adapters are tested.
 */

import { ConfigService } from '@nestjs/config';
import { ChannelType } from '@gosumo/shared';

import {
  TranscriptionService,
  TranscriptionUnavailableError,
} from './transcription.service';
import type { ChannelAdapterService } from '../../../channel-adapter/channel-adapter.service';

const DEFAULTS: Record<string, string> = {
  'transcription.apiKey': 'sk-test',
  'transcription.apiUrl': 'https://stt.test/v1/audio/transcriptions',
  'transcription.model': 'whisper-1',
};

describe('TranscriptionService', () => {
  let service: TranscriptionService;
  let config: { get: jest.Mock };
  let channelAdapter: { downloadMedia: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    config = {
      get: jest.fn((key: string, fallback?: string) =>
        key in DEFAULTS ? DEFAULTS[key] : fallback,
      ),
    };
    channelAdapter = {
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from('audio-bytes')),
    };
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    service = new TranscriptionService(
      config as unknown as ConfigService,
      channelAdapter as unknown as ChannelAdapterService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A successful STT response carrying `text`. */
  function sttOk(text: string): { ok: true; json: () => Promise<unknown> } {
    return { ok: true, json: () => Promise.resolve({ text }) };
  }

  // ─────────────────────────────────────────────
  // Configuration
  // ─────────────────────────────────────────────

  describe('configuration', () => {
    it('refuses to transcribe when no API key is configured', async () => {
      config.get.mockImplementation((key: string, fallback?: string) =>
        key === 'transcription.apiKey' ? '' : (DEFAULTS[key] ?? fallback),
      );

      await expect(
        service.transcribe('https://cdn.test/a.ogg', 'audio/ogg'),
      ).rejects.toThrow(TranscriptionUnavailableError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names the missing key so the failure is actionable', async () => {
      config.get.mockImplementation((key: string, fallback?: string) =>
        key === 'transcription.apiKey' ? '' : (DEFAULTS[key] ?? fallback),
      );

      await expect(
        service.transcribe('https://cdn.test/a.ogg', 'audio/ogg'),
      ).rejects.toThrow('TRANSCRIPTION_API_KEY is not configured');
    });

    it('posts to the configured endpoint with a bearer token', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        })
        .mockResolvedValueOnce(sttOk('hello'));

      await service.transcribe('https://cdn.test/a.ogg', 'audio/ogg');

      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe('https://stt.test/v1/audio/transcriptions');
      expect(init.method).toBe('POST');
      expect(init.headers.authorization).toBe('Bearer sk-test');
    });

    it('sends the configured model in the multipart body', async () => {
      config.get.mockImplementation((key: string, fallback?: string) =>
        key === 'transcription.model'
          ? 'whisper-large-v3'
          : (DEFAULTS[key] ?? fallback),
      );
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        })
        .mockResolvedValueOnce(sttOk('hello'));

      await service.transcribe('https://cdn.test/a.ogg', 'audio/ogg');

      const form = fetchMock.mock.calls[1][1].body as FormData;
      expect(form.get('model')).toBe('whisper-large-v3');
    });
  });

  // ─────────────────────────────────────────────
  // Audio retrieval
  // ─────────────────────────────────────────────

  describe('audio retrieval', () => {
    it('delegates a whatsapp-media reference to the channel adapter', async () => {
      fetchMock.mockResolvedValueOnce(sttOk('hello'));

      await service.transcribe('whatsapp-media://media-123', 'audio/ogg');

      expect(channelAdapter.downloadMedia).toHaveBeenCalledWith(
        ChannelType.WHATSAPP,
        'media-123',
      );
      // Only the STT call — the adapter did the download.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fetches an https URL directly', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        })
        .mockResolvedValueOnce(sttOk('hello'));

      await service.transcribe('https://cdn.test/a.ogg', 'audio/ogg');

      expect(channelAdapter.downloadMedia).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.test/a.ogg');
    });

    it('reports a refused audio download', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        service.transcribe('https://cdn.test/a.ogg', 'audio/ogg'),
      ).rejects.toThrow('Audio download failed: ECONNREFUSED');
    });

    it('stringifies a non-Error download rejection', async () => {
      fetchMock.mockRejectedValueOnce('socket hang up');

      await expect(
        service.transcribe('https://cdn.test/a.ogg', 'audio/ogg'),
      ).rejects.toThrow('Audio download failed: socket hang up');
    });

    it('reports a non-OK audio download by status', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(
        service.transcribe('https://cdn.test/a.ogg', 'audio/ogg'),
      ).rejects.toThrow('Audio download failed: 404');
    });
  });

  // ─────────────────────────────────────────────
  // STT call
  // ─────────────────────────────────────────────

  describe('speech-to-text call', () => {
    beforeEach(() => {
      channelAdapter.downloadMedia.mockResolvedValue(Buffer.from('audio'));
    });

    it('returns the transcribed text', async () => {
      fetchMock.mockResolvedValueOnce(sttOk('do teen bedroom chahiye'));

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).resolves.toBe('do teen bedroom chahiye');
    });

    it('trims surrounding whitespace', async () => {
      fetchMock.mockResolvedValueOnce(sttOk('  hello  \n'));

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).resolves.toBe('hello');
    });

    it('reports a refused STT request', async () => {
      fetchMock.mockRejectedValueOnce(new Error('timeout'));

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).rejects.toThrow('Transcription request failed: timeout');
    });

    it('stringifies a non-Error STT rejection', async () => {
      fetchMock.mockRejectedValueOnce('aborted');

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).rejects.toThrow('Transcription request failed: aborted');
    });

    it('surfaces an STT API error with its status and body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate limited'),
      });

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).rejects.toThrow('Transcription API error 429: rate limited');
    });

    it('falls back to the status when the error body cannot be read', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('stream closed')),
      });

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).rejects.toThrow('Transcription API error 500: status 500');
    });

    it('treats a missing text field as a failure, not an empty transcript', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).rejects.toThrow('Transcription returned no text');
    });

    it('treats a whitespace-only transcript as a failure', async () => {
      fetchMock.mockResolvedValueOnce(sttOk('   \n  '));

      await expect(
        service.transcribe('whatsapp-media://m1', 'audio/ogg'),
      ).rejects.toThrow('Transcription returned no text');
    });
  });

  // ─────────────────────────────────────────────
  // Upload filename
  // ─────────────────────────────────────────────

  describe('upload filename', () => {
    async function uploadedFileName(mimeType: string): Promise<string> {
      fetchMock.mockResolvedValueOnce(sttOk('hello'));
      await service.transcribe('whatsapp-media://m1', mimeType);

      const form = fetchMock.mock.calls[0][1].body as FormData;
      return (form.get('file') as File).name;
    }

    it.each([
      ['audio/mpeg', 'voice.mp3'],
      ['audio/mp3', 'voice.mp3'],
      ['audio/wav', 'voice.wav'],
      ['audio/mp4', 'voice.m4a'],
      ['audio/m4a', 'voice.m4a'],
      ['audio/ogg', 'voice.ogg'],
      ['application/octet-stream', 'voice.ogg'],
    ])('names a %s upload %s', async (mimeType, expected) => {
      // The provider infers the codec from the extension, so a wrong name here
      // is a silent transcription failure rather than an error.
      expect(await uploadedFileName(mimeType)).toBe(expected);
    });

    it('defaults an empty mime type to ogg', async () => {
      expect(await uploadedFileName('')).toBe('voice.ogg');
    });
  });

  describe('TranscriptionUnavailableError', () => {
    it('is identifiable by name after serialisation', () => {
      const err = new TranscriptionUnavailableError('nope');

      expect(err.name).toBe('TranscriptionUnavailableError');
      expect(err).toBeInstanceOf(Error);
    });
  });
});

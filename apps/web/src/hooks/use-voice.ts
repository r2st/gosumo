'use client';

import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { toQuery } from '@/lib/utils';

/** Terminal outcome of a broker voice command (mirrors the API). */
export type VoiceCommandStatus = 'executed' | 'not_understood' | 'unresolved' | 'failed';

/** One row of the broker voice-command history feed. */
export interface VoiceCommandHistoryItem {
  id: string;
  transcription: string;
  kind: string;
  status: VoiceCommandStatus;
  detail: string;
  createdAt: string;
}

const VOICE_COMMANDS_KEY = ['realty', 'voice', 'commands'];

/**
 * Broker voice-command history (blueprint §5.3). Dictated instructions —
 * "pause follow-ups for Rahul", "Serene Heights 2BHK now 94L" — and their
 * outcomes, newest first.
 */
export function useVoiceCommands(limit = 20) {
  return useQuery({
    queryKey: [...VOICE_COMMANDS_KEY, { limit }],
    queryFn: ({ signal }) =>
      apiRequest<VoiceCommandHistoryItem[]>(`/realty/voice/broker-commands${toQuery({ limit })}`, {
        signal,
      }),
    refetchInterval: 60_000,
  });
}

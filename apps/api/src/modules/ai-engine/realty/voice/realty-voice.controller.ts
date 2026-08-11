import { Body, Controller, Get, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger';
import { TenantId } from '../../../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { VoiceNoteProcessorService } from './voice-note-processor.service';
import { VoiceCommandHistoryService } from './voice-command-history.service';
import { TranscribeVoiceDto, BrokerVoiceCommandDto, ListVoiceCommandsQueryDto } from './dto';

/**
 * RealtyVoiceController — the broker-facing voice surface (blueprint §5.3).
 * JWT-guarded; `@TenantId()` scopes everything. Buyer voice notes are handled
 * automatically off the messaging spine (see VoiceMessageRouter), not here.
 */
@ApiTags('realty-voice')
@Controller('realty/voice')
export class RealtyVoiceController {
  constructor(
    private readonly processor: VoiceNoteProcessorService,
    private readonly history: VoiceCommandHistoryService,
  ) {}

  @Post('transcribe')
  @ApiOperation({ summary: 'Transcribe a voice note to text' })
  @ApiResponse({ status: 201, description: 'Result of the transcribe action' })
  async transcribe(@Body() dto: TranscribeVoiceDto): Promise<{ text: string }> {
    const text = await this.processor.transcribeVoiceNote(dto.mediaUrl, dto.mimeType ?? 'audio/ogg');
    return { text };
  }

  @Post('broker-command')
  @ApiOperation({ summary: 'Transcribe (if needed) and route a broker voice command' })
  @ApiResponse({ status: 201, description: 'The created broker command' })
  async brokerCommand(
    @TenantId() businessId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: BrokerVoiceCommandDto,
  ) {
    let transcription = dto.transcription?.trim();
    if (!transcription) {
      if (!dto.mediaUrl) {
        throw new BadRequestException('Provide either `transcription` or `mediaUrl`.');
      }
      transcription = await this.processor.transcribeVoiceNote(
        dto.mediaUrl,
        dto.mimeType ?? 'audio/ogg',
      );
    }
    const outcome = await this.processor.processBrokerVoiceCommand(businessId, transcription, {
      userId,
    });
    return { transcription, ...outcome };
  }

  @Get('broker-commands')
  @ApiOperation({ summary: 'List the broker voice-command history' })
  @ApiResponse({ status: 200, description: 'Paginated broker command list for this business' })
  async listBrokerCommands(
    @TenantId() businessId: string,
    @Query() query: ListVoiceCommandsQueryDto,
  ) {
    return this.history.list(businessId, query.limit ?? 50);
  }
}

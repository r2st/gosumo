import { IsString, IsOptional, IsObject } from "class-validator";

export class ConnectChannelDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  // ── WhatsApp fields ──
  @IsOptional()
  @IsString()
  phoneNumberId?: string;

  @IsOptional()
  @IsString()
  wabaId?: string;

  @IsOptional()
  @IsString()
  accessToken?: string;

  @IsOptional()
  @IsString()
  appSecret?: string;

  // ── Instagram fields ──
  @IsOptional()
  @IsString()
  pageId?: string;

  // ── SMS / Twilio fields ──
  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  accountSid?: string;

  @IsOptional()
  @IsString()
  authToken?: string;

  // ── Web Chat fields ──
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  primaryColor?: string;

  @IsOptional()
  @IsObject()
  widgetConfig?: Record<string, unknown>;

  // ── Email fields ──
  @IsOptional()
  @IsString()
  fromEmail?: string;

  @IsOptional()
  @IsString()
  fromName?: string;

  @IsOptional()
  @IsObject()
  smtp?: Record<string, unknown>;

  // ── Generic credentials object ──
  @IsOptional()
  @IsObject()
  credentials?: Record<string, unknown>;
}

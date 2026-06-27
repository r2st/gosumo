# Module: campaign

Enables proactive outreach to customers at scale. Supports broadcast campaigns (one-off announcements) and lifecycle campaigns (automated sequences triggered by customer behavior). Handles audience segmentation, scheduling, delivery via `channel-adapter`, and delivery tracking.

## Purpose

Send WhatsApp/SMS template messages to segmented audiences, schedule drip sequences, and track delivery/engagement. Trigger automatically when customers reach behavioral milestones (e.g., churn risk HIGH, order delivered).

## Public API (ICampaignService)

```typescript
createCampaign / getCampaign / listCampaigns / updateCampaign / deleteCampaign
scheduleCampaign(businessId, campaignId, dto): Promise<CampaignDto>
pauseCampaign / resumeCampaign / cancelCampaign
triggerCampaign(businessId, campaignId): Promise<void>    // immediate send
previewAudience(businessId, dto): Promise<AudiencePreviewDto>
getCampaignStats(businessId, campaignId): Promise<CampaignStatsDto>
triggerLifecycleCampaign(businessId, dto): Promise<void>
```

## Events

**Emits:**
- `campaign.triggered` — `{ businessId, campaignId, recipientCount, scheduledAt }`
- `campaign.sent` — `{ businessId, campaignId, clientId, messageId, channel }`
- `campaign.completed` — `{ businessId, campaignId, sent, failed, deliveryRate }`

**Listens to:**
- `booking.created` → check lifecycle campaigns triggered by `BOOKING_CREATED`
- `order.delivered` → check lifecycle campaigns triggered by `ORDER_DELIVERED`
- `client.churn.risk` → check lifecycle campaigns triggered by `CHURN_RISK`

## Tables Owned

- `campaigns` — campaign config, status, audience filter, schedule, BullMQ job reference, aggregated stats
- (Per-recipient send status stored in `messages` table with `campaign_id` foreign key)

## Dependencies

- `@gosumo/shared` — `CampaignStatus`, `CampaignType`, `ChannelType`
- `@gosumo/client-intelligence` — `listClients()` with filters for audience segmentation
- `@gosumo/channel-adapter` — `sendTemplate()` for each recipient
- `@gosumo/message` — `storeOutboundMessage()` for campaign messages
- BullMQ — delayed and rate-limited send jobs

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/campaign
```

## Key Gotchas

- **Broadcast campaigns require a channel-approved template** — `templateName` must exist and be approved on the Meta/SMS provider before scheduling; validate on `scheduleCampaign()`, not at send time
- **WhatsApp rate limit: 80 msg/sec** per phone number — BullMQ worker concurrency must be capped accordingly; never burst above this limit
- **Opt-out honored automatically:** clients with `channel_contacts.is_opted_in = false` for the target channel are excluded silently; increment `opt_out_count` on the campaign
- **Lifecycle deduplication:** a lifecycle campaign fires at most once per client per trigger event per day — check Redis key `campaign:{campaignId}:client:{clientId}:date:{YYYY-MM-DD}` before sending
- **Campaign pause mid-send:** BullMQ job must check `campaigns.status` on each batch before sending the next batch; if PAUSED, stop and re-queue remaining recipients
- **STARTER plan:** 500 sends/month; **GROWTH:** 5000; **SCALE:** unlimited — enforce in `scheduleCampaign()` by checking `businesses.plan_limits`
- Campaign send stats (`sent_count`, `delivered_count`, `read_count`) are updated by the worker after each message — use atomic increments, not full updates
- Deleting a campaign that is RUNNING is a soft delete — `deleted_at` set, but the BullMQ job must be paused/cancelled first

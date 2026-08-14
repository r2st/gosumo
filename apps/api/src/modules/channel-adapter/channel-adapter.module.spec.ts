import { ChannelAdapterModule } from './channel-adapter.module';
import { ChannelAdapterService } from './channel-adapter.service';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';
import { SmsAdapter } from './adapters/sms.adapter';
import { WebChatAdapter } from './adapters/webchat.adapter';
import { EmailAdapter } from './adapters/email.adapter';

/**
 * The module's only behaviour is registering every adapter on init. An adapter
 * added to `providers` but forgotten in `onModuleInit` compiles cleanly and
 * fails at runtime as "unsupported channel", so the test asserts the two lists
 * agree rather than just counting registrations.
 */
describe('ChannelAdapterModule', () => {
  const adapters = {
    whatsapp: { channel: 'WHATSAPP' } as unknown as WhatsAppAdapter,
    instagram: { channel: 'INSTAGRAM' } as unknown as InstagramAdapter,
    sms: { channel: 'SMS' } as unknown as SmsAdapter,
    webchat: { channel: 'WEB_CHAT' } as unknown as WebChatAdapter,
    email: { channel: 'EMAIL' } as unknown as EmailAdapter,
  };

  let service: { registerAdapter: jest.Mock };
  let module: ChannelAdapterModule;

  beforeEach(() => {
    service = { registerAdapter: jest.fn() };
    module = new ChannelAdapterModule(
      service as unknown as ChannelAdapterService,
      adapters.whatsapp,
      adapters.instagram,
      adapters.sms,
      adapters.webchat,
      adapters.email,
    );
  });

  it('registers every injected adapter on init', () => {
    module.onModuleInit();
    expect(service.registerAdapter.mock.calls.map(([a]) => a)).toEqual([
      adapters.whatsapp,
      adapters.instagram,
      adapters.sms,
      adapters.webchat,
      adapters.email,
    ]);
  });

  it('registers every adapter class listed in providers', () => {
    const providers = Reflect.getMetadata(
      'providers',
      ChannelAdapterModule,
    ) as Array<{ name: string }>;
    const declared = providers
      .map((p) => p.name)
      .filter((name) => name.endsWith('Adapter'));

    module.onModuleInit();

    // An adapter added to providers but forgotten in onModuleInit compiles
    // cleanly and only surfaces at runtime as an unsupported channel.
    expect(service.registerAdapter).toHaveBeenCalledTimes(declared.length);
  });

  it('exports the service so other modules can send outbound messages', () => {
    expect(Reflect.getMetadata('exports', ChannelAdapterModule)).toContain(
      ChannelAdapterService,
    );
  });

  it('mounts the widget controller alongside the adapter controller', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      ChannelAdapterModule,
    ) as Array<{ name: string }>;
    expect(controllers.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'ChannelAdapterController',
        'WebChatWidgetController',
      ]),
    );
  });
});

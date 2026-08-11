import { Module } from '@nestjs/common';
import { stripeClientProvider } from './stripe.provider';
import { BillingController } from './billing.controller';

@Module({
  controllers: [BillingController],
  providers: [stripeClientProvider],
  exports: [stripeClientProvider],
})
export class BillingModule {}

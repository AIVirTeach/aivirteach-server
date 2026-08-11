import {
  Controller,
  Headers,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { STRIPE_CLIENT } from './stripe.provider';

@Controller('billing')
export class BillingController {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripeClient: Stripe | null,
  ) {}

  @Post('webhook')
  handleWebhook(
    @Req() request: Request,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    if (!this.stripeClient) {
      throw new ServiceUnavailableException(
        'Billing is not configured — set STRIPE_SECRET_KEY',
      );
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new ServiceUnavailableException(
        'Billing webhook is not configured — set STRIPE_WEBHOOK_SECRET',
      );
    }

    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    try {
      const event = this.stripeClient.webhooks.constructEvent(
        request.body as Buffer,
        signature,
        webhookSecret,
      );
      // Entitlement write-through happens here once Course/Workspace modules exist.
      return { received: true, type: event.type };
    } catch {
      throw new BadRequestException('Invalid webhook signature');
    }
  }
}

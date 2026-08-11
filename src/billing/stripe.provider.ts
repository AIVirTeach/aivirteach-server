import { Provider } from '@nestjs/common';
import Stripe from 'stripe';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';

export const stripeClientProvider: Provider = {
  provide: STRIPE_CLIENT,
  useFactory: () => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return null;
    }
    return new Stripe(secretKey);
  },
};

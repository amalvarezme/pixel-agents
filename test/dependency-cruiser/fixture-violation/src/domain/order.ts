import { sendEmail } from '../adapters/email-adapter';

export function placeOrder(): string {
  return sendEmail();
}

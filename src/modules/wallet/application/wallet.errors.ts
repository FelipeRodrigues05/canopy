import { ApplicationError } from '../../../shared/application/application-error';

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly category = 'CONFLICT' as const;
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly category = 'NOT_FOUND' as const;
}

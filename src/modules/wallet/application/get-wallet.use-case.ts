import { Injectable } from '@nestjs/common';
import { WalletRepository } from './ports/wallet.repository';
import { WalletNotFoundError } from './wallet.errors';
import { type WalletView, toWalletView } from './wallet.view';

@Injectable()
export class GetWalletUseCase {
  constructor(private readonly wallets: WalletRepository) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(`Wallet ${walletId} not found`, { walletId });
    return toWalletView(wallet);
  }
}

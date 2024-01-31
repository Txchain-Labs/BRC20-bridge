import { defineStore } from 'pinia'

interface WalletData {
  address: string
  network: string
}

export const useWalletStore = defineStore('wallet', {
  state: () => {
    return {
      address: '',
      provider: null,
      acc_short: '',
      message: '',
      signature: '',
    }
  },

  actions: {
    //@ts-ignore
    saveWalletData(payload: WalletData) {
      this.address = payload.address
      this.network = payload.network
      this.acc_short = `${payload.address.slice(
        0,
        2
      )}...${payload.address.slice(-4)}`
    },
    saveSignature(message: string, signature: string) {
      this.message = message
      this.signature = signature
    },
  },
})

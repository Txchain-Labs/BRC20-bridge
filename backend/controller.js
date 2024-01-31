import { MongoClient } from "mongodb";
import fetch from 'node-fetch';
import { Contract, ethers } from 'ethers';
import { txHelpers } from '@unisat/wallet-sdk';
import {
  mintTokens,
  approveForBurn,
  burnTokens,
} from './contract-methods.js'

import CHSD_ABIJSON from './ChainstackDollars.json' with { type: "json" };
import QCHSD_ABIJSON from './DChainstackDollars.json' with { type: "json" };

const provider = new ethers.AnkrProvider('goerli', process.env.ANKR_KEY);

let THIRTY_MINUTES = 30 * 60 * 1000;

const ORIGIN_TOKEN_CONTRACT_ADDRESS = process.env.ORIGIN_TOKEN_CONTRACT_ADDRESS
const DESTINATION_TOKEN_CONTRACT_ADDRESS =
  process.env.DESTINATION_TOKEN_CONTRACT_ADDRESS
const BRIDGE_WALLET = process.env.BRIDGE_WALLET
const BRIDGE_WALLET_KEY = process.env.BRIDGE_PRIV_KEY

export async function checkDeposit() {
  console.log("💰 DEPOSIT CHECKING")
  let query = { $and: [{ completed: false }, { deposited: false }] };
  let result = await collection.find(query)
    .toArray();

  console.log("connected", result)

  if (result === null) {
    return;
  } else {

    for (let i = 0; i < result.length; i++) {

      const response = await fetch(`https://api.hiro.so/ordinals/v1/brc-20/balances/${result[i].btcAddress}?ticker=${result[i].ticker}`);
      const data = await response.json();

      if (data.results.length == 0) {
        if (new Date().valueOf() - new Date(result[i].date).valueOf() > THIRTY_MINUTES) {
          console.log("writing - skip old transactions")
          let rit = await collection.updateOne({ txid: result[i].txid }, { $set: { completed: true } })
          console.log(rit, "rit")
        }
        continue;
      }
      const balance = data.results[0].overall_balance;
      console.log({ balance })
      if (balance >= result[i].amount) {
        await collection.updateOne({ txid: result[i].txid }, { $set: { deposited: true } })
        const tokensMinted = await mintTokens(provider, contract, value, from)
        console.log("💰 DEPOSITed! So minting now!", { tokensMinted })
      }
    }
  }
}

export async function checkWithdraw() {
  let query = { $and: [{ completed: false }, { burnt: true}] };
  let result = await collection.find(query)
    .toArray();

  console.log("connected", result)
  console.log("💸 WITHDREW CHECKING!")

  if (result === null) {
    return;
  } else {
    for (let i = 0; i < result.length; i++) {
      // Check Tx confirmation count
      if (balance >= result[i].amount) {
        console.log("💸 WITHDREWed!", { data: result[i] })
        await collection.updateOne({ txid: result[i].txid }, { $set: { completed: true } })
      }
    }
  }
}

const handleMintedEvent = async (
  from, value,
  providerDest,
  contractDest
) => {
  console.log('handleMintedEvent')
  console.log('from :>> ', from)
  console.log('value :>> ', value)
  console.log('============================')

  if (from == process.env.WALLET_ZERO) {
    console.log('Tokens minted')
    return
  }

  let query = { $and: [{ completed: false }, { deposited: true }, {ethAddress: from}, {token: contractDest}] };
  let result = await collection.find(query).limit(1)
    .toArray();
  if (!result) return;
  await collection.updateOne({ txid: result[0].txid }, { $set: { completed: true } })
}

const sendOrdinalsInscriptions = async ({
  to,
  inscriptionIds,
  feeRate,
  enableRBF,
  btcUtxos
}) => {
  const account = preferenceService.getCurrentAccount();
  if (!account) throw new Error('no current account');

  const networkType = preferenceService.getNetworkType();

  const inscription_utxos = await openapiService.getInscriptionUtxos(inscriptionIds);
  if (!inscription_utxos) {
    throw new Error('UTXO not found.');
  }

  if (inscription_utxos.find((v) => v.inscriptions.length > 1)) {
    throw new Error('Multiple inscriptions are mixed together. Please split them first.');
  }

  const assetUtxos = inscription_utxos.map((v) => {
    return Object.assign(v, { pubkey: account.pubkey });
  });

  if (!btcUtxos) {
    btcUtxos = await this.getBTCUtxos();
  }

  if (btcUtxos.length == 0) {
    throw new Error('Insufficient balance.');
  }

  const { psbt, toSignInputs } = await txHelpers.sendInscriptions({
    assetUtxos,
    btcUtxos,
    toAddress: to,
    networkType,
    changeAddress: account.address,
    feeRate,
    enableRBF
  });

  this.setPsbtSignNonSegwitEnable(psbt, true);
  await this.signPsbt(psbt, toSignInputs, true);
  this.setPsbtSignNonSegwitEnable(psbt, false);

  return psbt.toHex();
};

const handleDestinationEvent = async (
  from, to, value,
  providerDest,
  contractDest
) => {
  console.log('handleDestinationEvent')
  console.log('to :>> ', to)
  console.log('from :>> ', from)
  console.log('value :>> ', value)
  console.log('============================')

  if (from == process.env.WALLET_ZERO) {
    console.log('Tokens minted')
    return
  }

  if (to == BRIDGE_WALLET && to != from) {
    console.log(
      'Tokens received on bridge from destination chain! Time to bridge back!'
    )

    try {
      // we need to approve burn, then burn
      const tokenBurnApproved = await approveForBurn(
        providerDest,
        contractDest,
        value
      )
      if (!tokenBurnApproved) return
      console.log('Tokens approved to be burnt')
      const tokensBurnt = await burnTokens(providerDest, contractDest, value)

      if (!tokensBurnt) return
      console.log(
        'Tokens burnt on destination, time to transfer tokens in ETH side'
      )
      // SEND ORDIANL TO RECEVING ADDRESS!!
      // const transferBack = await transferToEthWallet(
      //   provider,
      //   contract,
      //   value,
      //   from
      // )

      let query = { $and: [{ completed: false }, { burnt: false }, {ethAddress: from}, {token: contractDest}] };
      let result = await collection.find(query).limit(1)
        .toArray();
      if (!result) return;
      await collection.updateOne([{ completed: false }, { burnt: false }, {ethAddress: from}, {token: contractDest}], { $set: { burnt: true } })
      const transferBack = await sendOrdinalsInscriptions({
        // to: 
      })
      if (!transferBack) return
      console.log(transferBack)
      // Save TxID
      console.log('Tokens transfered to ETH wallet')
      console.log('🌈🌈🌈🌈🌈 Bridge back operation completed')
    } catch (err) {
      console.error('Error processing transaction', err)
      // TODO: return funds
    }
  } else {
    console.log('Something else triggered Transfer event')
  }
}

export const main = async () => {
  const destinationWebSockerProvider = new ethers.AnkrProvider('goerli', process.env.ANKR_KEY);
  // adds account to sign transactions
  const destNetworkId = process.env.BRIDGE_CHAIN_ID;
  console.log('destNetworkId :>> ', destNetworkId)

  const destinationTokenContract = new Contract(DESTINATION_TOKEN_CONTRACT_ADDRESS, QCHSD_ABIJSON.abi, destinationWebSockerProvider);
  let options = {
    // filter: {
    //   value: ['1000', '1337'], //Only get events where transfer value was 1000 or 1337
    // },
    // fromBlock: 0, //Number || "earliest" || "pending" || "latest"
    // toBlock: 'latest',
  }

  destinationTokenContract.on('Transfer', (from, to, value) => {
    handleDestinationEvent(
      from, to, value,
      destinationWebSockerProvider,
      destinationTokenContract
    )
  })

  destinationTokenContract.on('TokensMinted', (from, value) => {
    handleMintedEvent(
      from, value,
      destinationWebSockerProvider,
      destinationTokenContract
    )
  })
}

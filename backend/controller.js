import { MongoClient, ObjectId } from "mongodb";
import fetch from 'node-fetch';
import { ethers } from 'ethers';
import Web3 from "web3";
import {
  mintTokens,
  approveForBurn,
  burnTokens,
} from './contract-methods.js'

import CHSD_ABIJSON from './ChainstackDollars.json' assert { type: "json" };
import QCHSD_ABIJSON from './DChainstackDollars.json' assert { type: "json" };
import { requestsCollection, db } from "./mongoConfig.js";
import { checkOrder, sendBrc, sendInscription, brcbalance } from "./unisat.js";
import { core, address, utils } from '@unisat/wallet-sdk';

const provider = new ethers.AnkrProvider('goerli', process.env.ANKR_KEY);

let THIRTY_MINUTES = 30 * 60 * 1000;

const ORIGIN_TOKEN_CONTRACT_ADDRESS = process.env.ORIGIN_TOKEN_CONTRACT_ADDRESS
const DESTINATION_TOKEN_CONTRACT_ADDRESS =
  process.env.DESTINATION_TOKEN_CONTRACT_ADDRESS
const BRIDGE_WALLET = process.env.BRIDGE_WALLET
const BRIDGE_WALLET_KEY = process.env.BRIDGE_PRIV_KEY

const destinationWebSockerProvider = new Web3("wss://goerli.infura.io/ws/v3/ef80761adf9346b6b4ec941fdb91de64")
// adds account to sign transactions
destinationWebSockerProvider.eth.accounts.wallet.add(BRIDGE_WALLET_KEY)
const destinationTokenContract = new destinationWebSockerProvider.eth.Contract(QCHSD_ABIJSON.abi, DESTINATION_TOKEN_CONTRACT_ADDRESS);


export async function checkDeposit() {
  console.log("💰 DEPOSIT CHECKING")
  let query = { $and: [{ type: 0 }, { completed: false }, { deposited: false }] };
  let result = await requestsCollection.find(query)
    .toArray();

  console.log("connected", result)

  if (result === null) {
    return;
  } else {
    for (let i = 0; i < result.length; i++) {

      const balance = await brcbalance(result[i].btcAddress, result[i].ticker)
      console.log({ balance })
      if (balance >= result[i].amount) {
        await requestsCollection.updateOne(result[i], { $set: { deposited: true, completed: true } }) // should not complete
        const tokensMinted = await mintTokens(destinationWebSockerProvider, destinationTokenContract, ethers.parseUnits(result[i].amount, 18), result[i].ethAddress)
        console.log("💰 DEPOSITed! So minting now!", { tokensMinted })
      }
    }
  }
}

export async function checkTransferInscriptions() {
  let query = { $and: [{ type: 1 }, { completed: false }, { inscribing: true }] };
  let result = await requestsCollection.find(query)
    .toArray();
  console.log("📝 INCSCIRTIPN CHECKING")
  if (result === null) {
    return;
  } else {
    console.log(`FOUND ${result.length} transferInscriptions pending`);
    for (let i = 0; i < result.length; i++) {
      const inscriptionId = await checkOrder(result[i].orderId)
      if (inscriptionId) {
        console.log(`inscription ${inscriptionId} Finished! Sending it!!`);
        await sendInscription(inscriptionId, result[i].btcAddress)
        await requestsCollection.updateOne(result[i], { $set: { completed: true } })
        console.log('🌈🌈🌈🌈🌈 Bridge back operation completed. Check your arrival in btc!!')
      }
    }
  }
}

export async function checkWithdraw() {
  let query = { $and: [{ completed: false }, { burnt: true }] };
  let result = await requestsCollection.find(query)
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
        await requestsCollection.updateOne(result[i], { $set: { completed: true } })
      }
    }
  }
}

const handleMintedEvent = async (
  to, value,
  providerDest,
  contractDest
) => {
  console.log('handleMintedEvent')
  console.log('from :>> ', to)
  console.log('value :>> ', value)
  console.log('============================')

  console.log('Tokens minted')

  let query = { $and: [{ completed: false }, { deposited: true }, { ethAddress: to }, { token: contractDest.options.address }] };
  let result = await requestsCollection.find(query).limit(1)
    .toArray();
  if (!result) return;
  await requestsCollection.updateOne(result[0], { $set: { completed: true } })
}

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
    handleMintedEvent(to, value, providerDest, contractDest)
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
        'Tokens burnt on destination, time to transfer tokens in BTC side'
      )
      // SEND ORDIANL TO RECEVING ADDRESS!!
      // const transferBack = await transferToEthWallet(
      //   provider,
      //   contract,
      //   value,
      //   from
      // )

      let query = { $and: [{ completed: false }, { burnt: false }, { ethAddress: from }, { token: contractDest.options.address }] };
      let result = await requestsCollection.find(query).limit(1)
        .toArray();
      if (!result) {
        console.log("NO DB RECORD??")
        return;
      }
      await requestsCollection.updateOne(result[0], { $set: { burnt: true } });

      const anotherWallet = "tb1qny6666d9cy39q4mxm9gauwk8ky9xx0r692vvun"
      const orderId = await sendBrc(result[0].ticker, value)
      if (!orderId) return;
      console.log("mongo record id:", result[0]._id)
      await requestsCollection.updateOne(result[0], { $set: { inscribing: true, orderId } });
      console.log(orderId)
      // Save TxID
      console.log('Transfer Inscription created to BTC wallet. Waiting for the order minted...')
    } catch (err) {
      console.error('Error processing transaction', err)
      // TODO: return funds
    }
  } else {
    console.log('Something else triggered Transfer event')
  }
}

export const main = async () => {
  let options = {
    // filter: {
    //   value: ['1000', '1337'], //Only get events where transfer value was 1000 or 1337
    // },
    // fromBlock: 0, //Number || "earliest" || "pending" || "latest"
    // toBlock: 'latest',
  }
  console.log(destinationTokenContract.options.address)
  destinationTokenContract.events
    .allEvents(options, (event) => {
      console.log({ event })
    })

  destinationTokenContract.events
    .Transfer(options)
    .on('data', async (event) => {
      console.log('safsf');
      handleDestinationEvent(
        event.returnValues.from, event.returnValues.to, event.returnValues.value,
        destinationWebSockerProvider,
        destinationTokenContract
      )
    })

  // const anotherWallet = "tb1qny6666d9cy39q4mxm9gauwk8ky9xx0r692vvun"
  // // const transferBack = await sendBrc(anotherWallet, 'euph', '10')

  // await sendInscription("a667d99e4f082a90abb964ab17f57f17c89ba19a00b109760f0769ee0401f1d9i0", anotherWallet)
}

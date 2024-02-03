import cors from 'cors';
import express, { request } from 'express';
import session from 'express-session';
import cookieSession from 'cookie-session';
import { generateNonce, SiweMessage } from 'siwe';
import { core, address, utils } from '@unisat/wallet-sdk';
import dotenv from 'dotenv';
dotenv.config();
import { requestsCollection, btcKeyPairsCollection } from './mongoConfig.js'
import { checkDeposit, checkTransferInscriptions, main } from './controller.js';
import cron from 'node-cron';

cron.schedule('* * * * *', () => {
  console.log("======= CRON ========")
  checkDeposit();
  checkTransferInscriptions();
});

main();

const app = express();
app.use(express.json());

//  Session setup
app.use(session({
  secret: 'wow very secret',
  cookie: {
    maxAge: 600000,
    secure: false
  },
  saveUninitialized: false,
  resave: false,
  unset: 'keep'
}));

app.use(cors({
  origin: ['http://localhost:3000', 'http://24.199.116.139:3000'],
  credentials: true,
  exposedHeaders: ['set-cookie']
}))

app.get('/nonce', async function (req, res) {
  req.session.nonce = generateNonce();
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send(req.session.nonce);
});

app.post('/verify', async function (req, res) {
  try {
    if (!req.body.message) {
      res.status(422).json({ message: 'Expected prepareMessage object as body.' });
      return;
    }

    let SIWEObject = new SiweMessage(req.body.message);
    const { data: message } = await SIWEObject.verify({ signature: req.body.signature, nonce: req.session.nonce });

    console.log({ nonce: req.session.nonce })

    req.session.siwe = message;
    // req.session.cookie.expires = new Date(message.expirationTime);
    req.session.save(() => res.status(200).send(true));
  } catch (e) {
    req.session.siwe = null;
    req.session.nonce = null;
    console.error(e);
    switch (e) {
      // case ErrorTypes.EXPIRED_MESSAGE: {
      //   req.session.save(() => res.status(440).json({ message: e.message }));
      //   break;
      // }
      // case ErrorTypes.INVALID_SIGNATURE: {
      //   req.session.save(() => res.status(422).json({ message: e.message }));
      //   break;
      // }
      default: {
        req.session.save(() => res.status(500).json({ message: e.message }));
        break;
      }
    }
  }
});

app.get('/personal_information', function (req, res) {
  if (!req.session.siwe) {
    res.status(401).json({ message: 'You have to first sign_in' });
    return;
  }
  console.log("User is authenticated!");
  res.setHeader('Content-Type', 'text/plain');
  res.send(`You are authenticated and your address is: ${req.session.siwe.address}`);
});

const getReceiverAddress = async function (address) {
  let result = await requestsCollection.find({ $and: [{ type: 0 }, { completed: false }, { ethAddress: address }] }).limit(1).toArray();
  if (result.length) return result[0].btcAddress;
  else return false;
}

const hasPendingRequest = async function (address, ticker) {
  let result = await requestsCollection.find({ $and: [{ type: 0 }, { completed: false }, { ethAddress: address }, { ticker: ticker }] }).limit(1).toArray();
  return result.length > 0
}

const generateAddress = async function () {
  const newPair = core.ECPair.makeRandom({
    network: core.bitcoin.networks.testnet
  })
  const receivingAddress = core.bitcoin.payments.p2wpkh({ pubkey: newPair.publicKey, network: core.bitcoin.networks.testnet }).address
  console.log({ receivingAddress })
  // console.log(receivingAddress)
  await btcKeyPairsCollection.insertOne({
    privateKey: newPair.privateKey,
    address: receivingAddress
  });
  return receivingAddress
}

async function brcTickerFromEthAddress(address) {
  // TODO get from tokens collection in mongoDB
  return 'euph';
}

app.post('/receive_address', async function (req, res) {
  console.log(req.session)
  if (!req.session.siwe) {
    res.status(401).json({ message: 'You have to first sign_in' });
    return;
  }
  const address = await getReceiverAddress(req.session.siwe.address);
  if (address) {
    res.status(200).json({ address })
    return;
  }
  res.status(500).json({ message: `Error you don't have pending requests` });
});

app.post('/request_brc_to_erc', async function (req, res) {
  if (!req.session.siwe) {
    res.status(401).json({ message: 'You have to first sign_in' });
    return;
  }
  let toAddress = await getReceiverAddress(req.session.siwe.address);
  const hasPending = await hasPendingRequest(req.session.siwe.address, req.body.ticker);
  if (hasPending) {
    req.session.save(() => res.status(500).json({ toAddress }));
    return;
  }
  if (!toAddress) {
    toAddress = await generateAddress()
  }
  // Store request
  await requestsCollection.insertOne({
    type: 0,
    completed: false,
    deposited: false,
    burnt: false,
    inscribing: false,
    btcAddress: toAddress,
    ethAddress: req.session.siwe.address,
    ticker: req.body.ticker,
    amount: req.body.amount,
  });
  res.status(200).json({ toAddress })
})

app.post('/request_erc_to_brc', async function (req, res) {
  if (!req.session.siwe) {
    res.status(401).json({ message: 'You have to first sign_in' });
    return;
  }

  let result = await requestsCollection.find({ $and: [{ type: 1 }, { completed: false }, { ethAddress: req.session.siwe.address }, { token: req.body.tokenAddress }] }).limit(1).toArray();
  const ticker = await brcTickerFromEthAddress(req.body.tokenAddress)
  if (result.length) {
    req.session.save(() => res.status(500).json({ message: `Error! You have pending bridge request for ${ticker}` }));
    return;
  }
  await requestsCollection.insertOne({
    type: 1,
    completed: false,
    deposited: false,
    burnt: false,
    inscribing: false,
    btcAddress: req.body.btcAddress,
    ethAddress: req.session.siwe.address,
    ticker: ticker,
    token: req.body.tokenAddress,
  });
  res.status(200).json(true)
})


app.listen(4000, '0.0.0.0');

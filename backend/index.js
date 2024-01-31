import cors from 'cors';
import express, { request } from 'express';
import Session from 'express-session';
import { generateNonce, SiweMessage } from 'siwe';
import { core, address } from '@unisat/wallet-sdk';
import dotenv from 'dotenv';
dotenv.config();
import { requestsCollection, btcKeyPairsCollection } from './mongoConfig.js'
import { checkDeposit, checkWithdraw, main } from './controller.js';
import cron from 'node-cron';

cron.schedule('10 * * * *', () => {
  checkDeposit();
  checkWithdraw();
});

main();

const app = express();
app.use(express.json());
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
}))

app.use(Session({
  name: 'siwe-quickstart',
  secret: "siwe-quickstart-secret",
  resave: true,
  saveUninitialized: true,
  cookie: { secure: false, sameSite: true }
}));

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

    console.log({message})

    req.session.siwe = message;
    req.session.cookie.expires = new Date(message.expirationTime);
    req.session.save(() => res.status(200).send(true));
  } catch (e) {
    req.session.siwe = null;
    req.session.nonce = null;
    console.error(e);
    switch (e) {
      case ErrorTypes.EXPIRED_MESSAGE: {
        req.session.save(() => res.status(440).json({ message: e.message }));
        break;
      }
      case ErrorTypes.INVALID_SIGNATURE: {
        req.session.save(() => res.status(422).json({ message: e.message }));
        break;
      }
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

const receiverAddress = async function (req) {
  let result = await requestsCollection.find({ $and: [{ type: 0 }, { completed: false }, { ethAddress: req.session.siwe.address }, { ticker: req.body.ticker }] }).limit(1).toArray();
  if (result.length) {
    return false;
  }
  result = await requestsCollection.find({ $and: [{ type: 0 }, { completed: false }, { ethAddress: req.session.siwe.address }] }).limit(1).toArray();
  let receivingAddress;
  if (result.length) {
    receivingAddress = result[0].btcAddress;
  } {
    // Generate Receving Address
    const newPair = core.ECPair.makeRandom()
    receivingAddress = newPair.privateKey;
    receivingAddress = address.publicKeyToAddress(newPair.privateKey);
    await btcKeyPairsCollection.insertOne({
      privateKey: newPair.privateKey,
      address: receivingAddress
    });
  }
  return receivingAddress
}

app.get('/receive_address', async function (req, res) {
  if (!req.session.siwe) {
    res.status(401).json({ message: 'You have to first sign_in' });
    return;
  }
  const address = await receiverAddress(req, res);
  if (!address) {
    req.session.save(() => res.status(500).json({ message: `Error! You have pending bridge request for ${req.body.ticker}` }));
    return;
  }
  res.status(200).json({ address })
});

app.post('/request_brc_to_erc', async function (req, res) {
  if (!req.session.siwe) {
    res.status(401).json({ message: 'You have to first sign_in' });
    return;
  }
  const address = await receiverAddress(req, res);
  if (!address) {
    req.session.save(() => res.status(500).json({ message: `Error! You have pending bridge request for ${req.body.ticker}` }));
    return;
  }
  // Store request
  await requestsCollection.insertOne({
    type: 0,
    completed: false,
    deposited: false,
    minting: false,
    btcAddress: receivingAddress,
    ethAddress: req.session.siwe.address,
    token: '',
    ticker: req.body.ticker,
  });
})

app.post('/request_erc_to_brc', async function (req, res) {
  if (!req.session.siwe) {
    res.status(401).json({ message: 'You have to first sign_in' });
    return;
  }

  let result = await requestsCollection.find({ $and: [{ type: 1 }, { completed: false }, { ethAddress: req.session.siwe.address }, { token: req.body.token }] }).limit(1).toArray();
  if (result.length) {
    req.session.save(() => res.status(500).json({ message: `Error! You have pending bridge request for ${req.body.ticker}` }));
    return;
  }
  await requestsCollection.insertOne({
    type: 1,
    completed: false,
    deposited: false,
    burnt: false,
    btcAddress: req.body.btcAddress,
    ethAddress: req.session.siwe.address,
    token: req.body.token,
    ticker: '',
  });
})


app.listen(4000);

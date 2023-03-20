import {
  randomFill,
  randomFillSync,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';

import { promisify } from 'node:util';

import { Readable } from 'node:stream';

export default {
  async fetch() {

    // Random bytes, numbers, and UUIDs
    const buf = new Uint8Array(10);
    randomFillSync(buf);
    console.log(buf);
    await promisify(randomFill)(buf);
    console.log(buf);
    console.log(randomBytes(10));
    console.log(await promisify(randomBytes)(10));
    console.log(randomInt(0, 10));
    console.log(randomInt(10));
    console.log(await promisify(randomInt)(10));
    console.log(randomUUID());

    // Let's create a Node.js stream of random numbers...
    // then use Node.js' stream reduce operator to sum them...
    let n = 0;
    const readable = new Readable({
      objectMode: true,
      read(size) {
        for (let count = 0; count < size; count++) {
          this.push(randomInt(100))
          if (++n === 200) {
            this.push(null);
            break;
          }
        }
      }
    });
    console.log(await readable.reduce((p, c) => p + c, 0));

    return new Response("ok");
  }
};

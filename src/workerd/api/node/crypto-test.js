import {
  ok,
  rejects,
  strictEqual,
  throws,
} from 'node:assert';

import {
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
} from 'node:crypto';

import { promisify } from 'node:util';

import { Buffer } from 'node:buffer';

export const randomIntTest = {
  async test(ctrl, env, ctx) {
    function checkRange(n, min, max) {
      ok(n >= min && n <= max);
    }
    for (let n = 0; n < 100; n++) {
      checkRange(randomInt(10), 0, 10);
    }
    for (let n = 0; n < 100; n++) {
      checkRange(randomInt(5, 15), 5, 15);
    }
    for (let n = 0; n < 100; n++) {
      checkRange(randomInt(100, 200), 100, 200);
    }

    const ri = promisify(randomInt);
    for (let n = 0; n < 100; n++) {
      checkRange(await ri(10), 0, 10);
    }
    for (let n = 0; n < 100; n++) {
      checkRange(await ri(5, 15), 5, 15);
    }
    for (let n = 0; n < 100; n++) {
      checkRange(await ri(100, 200), 100, 200);
    }
  }
};

export const randomFillTest = {
  async test(ctrl, env, ctx) {
    const u8 = new Uint8Array(10);
    strictEqual(u8, randomFillSync(u8));
    strictEqual(u8, randomFillSync(u8, 1));
    strictEqual(u8, randomFillSync(u8, 9, 1));
    throws(() => randomFillSync(u8, 10, 1), { code: 'ERR_OUT_OF_RANGE' });

    const rf = promisify(randomFill);
    strictEqual(u8, await rf(u8));
    strictEqual(u8, await rf(u8, 1));
    strictEqual(u8, await rf(u8, 9, 1));
    await rejects(rf(u8, 10, 1), { code: 'ERR_OUT_OF_RANGE' });
  }
}

export const randomBytesTest = {
  async test(ctrl, env, ctx) {
    const u8 = randomBytes(10);
    ok(u8 instanceof Buffer);
    strictEqual(u8.byteLength, 10);
    throws(() => randomBytes('abc'), { code: 'ERR_INVALID_ARG_TYPE' });
  }
}

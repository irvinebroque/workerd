// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Adapted from Node.js. Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

/* todo: the following is adopted code, enabling linting one day */
/* eslint-disable */
import {
  validateObject,
  validateBoolean,
  validateFunction,
  validateInteger,
} from 'node-internal:validators';

import {
  isAnyArrayBuffer,
  isArrayBufferView
} from 'node-internal:internal_types';

import {
  ERR_INVALID_ARG_TYPE,
  ERR_OUT_OF_RANGE,
} from 'node-internal:internal_errors';

import {
  Buffer,
  kMaxLength
} from 'node-internal:internal_buffer';

export type RandomBytesCallback = (err: any|null, buffer: Uint8Array) => void;
export function randomBytes(size: number, callback: RandomBytesCallback): void;
export function randomBytes(size: number): Uint8Array;
export function randomBytes(size: number, callback?: RandomBytesCallback) : Uint8Array|void{
  validateInteger(size, 'size', 0, kMaxLength);
  const buf = Buffer.alloc(size);
  if (callback !== undefined) {
    randomFill(buf, callback as RandomFillCallback);
  } else {
    randomFillSync(buf);
    return buf;
  }
}

export function randomFillSync(
    buffer: ArrayBufferView|ArrayBuffer,
    offset?: number,
    size?: number) {
  if (!isAnyArrayBuffer(buffer) && !isArrayBufferView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE('buffer', [
      'TypedArray',
      'DataView',
      'ArrayBuffer',
      'SharedArrayBuffer'
    ],buffer);
  }
  const maxLength = (buffer as Uint8Array).length;
  if (offset !== undefined) {
    validateInteger(offset!, 'offset', 0, kMaxLength);
  } else offset = 0;
  if (size !== undefined) {
    validateInteger(size!, 'size', 0, maxLength - offset);
  } else size = maxLength;
  if (isAnyArrayBuffer(buffer)) {
    buffer = Buffer.from(buffer as ArrayBuffer);
  }
  crypto.getRandomValues((buffer as Buffer).subarray(offset, offset + size));
  return buffer;
}

export type RandomFillCallback = (err: any|null, buf?: ArrayBufferView|ArrayBuffer) => void;
export function randomFill(buffer: ArrayBufferView|ArrayBuffer,
                           callback?: RandomFillCallback) : void;
export function randomFill(buffer: ArrayBufferView|ArrayBuffer,
                           offset: number,
                           callback?: RandomFillCallback) : void;
                           export function randomFill(buffer: ArrayBufferView|ArrayBuffer,
                           offset: number,
                           size: number,
                           callback?: RandomFillCallback) : void;
export function randomFill(buffer: ArrayBufferView|ArrayBuffer,
                           offsetOrCallback?: number|RandomFillCallback,
                           sizeOrCallback?: number|RandomFillCallback,
                           callback?: RandomFillCallback) {
  if (!isAnyArrayBuffer(buffer) && !isArrayBufferView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE('buffer', [
      'TypedArray',
      'DataView',
      'ArrayBuffer',
      'SharedArrayBuffer'
    ],buffer);
  }

  let offset = 0;
  let size = 0;
  const maxLength = (buffer as Uint8Array).length;
  if (typeof callback === 'function') {
    validateInteger(offsetOrCallback, 'offset', 0, maxLength);
    offset = offsetOrCallback as number;

    validateInteger(sizeOrCallback, 'size', 0, maxLength - offset);
    size = sizeOrCallback as number;
  } else if (typeof sizeOrCallback === 'function') {
    validateInteger(offsetOrCallback, 'offset', 0, maxLength);
    offset = offsetOrCallback as number;
    size = maxLength - offset;
    callback = sizeOrCallback as RandomFillCallback;
  } else if (typeof offsetOrCallback === 'function') {
    offset = 0;
    size = maxLength;
    callback = offsetOrCallback as RandomFillCallback;
  }
  validateFunction(callback, 'callback');

  // We're currently not actually implementing the fill itself asynchronously,
  // so we defer to randomFillSync here, but we invoke the callback asynchronously.
  new Promise<void>((res) => {
    randomFillSync(buffer, offset, size);
    res();
  }).then(() => callback!(null, buffer), (err: any) => callback!(err));
}

const RAND_MAX = 0xFFFF_FFFF_FFFF;
// Cache random data to use in randomInt. The cache size must be evenly
// divisible by 6 because each attempt to obtain a random int uses 6 bytes.
const randomCache = Buffer.alloc(6 * 1024);
let randomCacheOffset = 0;
let initialized = false;

// The implementation here is adapted directly from Node.js. The way it works
// is fairly straightforward. An internal cache (randomCache) is generated
// first. When we want to select a random int from it, we scan through until
// we find a value that is within the given range. When we run out of cache
// to scan through, we generate a new cache. Doing it this way makes generating
// multiple random ints very efficient.
function getRandomInt(min: number, max: number) {
  if (!initialized) {
    randomFillSync(randomCache);
    initialized = true;
  }
  // First we generate a random int between [0..range)
  const range = max - min;

  if (!(range <= RAND_MAX)) {
    throw new ERR_OUT_OF_RANGE(`max${max ? '' : ' - min'}`, `<= ${RAND_MAX}`, range);
  }

  // For (x % range) to produce an unbiased value greater than or equal to 0 and
  // less than range, x must be drawn randomly from the set of integers greater
  // than or equal to 0 and less than randLimit.
  const randLimit = RAND_MAX - (RAND_MAX % range);

  // If we don't have a callback, or if there is still data in the cache, we can
  // do this synchronously, which is super fast.
  while (randomCacheOffset < randomCache.length) {
    if (randomCacheOffset === randomCache.length) {
      // This might block the thread for a bit, but we are in sync mode.
      randomFillSync(randomCache);
      randomCacheOffset = 0;
    }

    const x = randomCache.readUIntBE(randomCacheOffset, 6);
    randomCacheOffset += 6;
    if (x < randLimit) {
      const n = (x % range) + min;
      return n;
    }
  }
  return 0; // Should be unreachable.
}

export type RandomIntCallback = (err: any|null, n?: number) => void;
export function randomInt(max: number) : number;
export function randomInt(min: number, max: number) : number;
export function randomInt(max: number, callback: RandomIntCallback) : void;
export function randomInt(min: number, max: number, callback: RandomIntCallback) : void;
export function randomInt(minOrMax: number,
                          maxOrCallback?: number|RandomIntCallback,
                          callback?: RandomIntCallback) {
  let min = 0;
  let max = 0;
  if (typeof callback === 'function') {
    validateInteger(minOrMax, 'min');
    validateInteger(maxOrCallback, 'max');
    min = minOrMax as number;
    max = maxOrCallback as number;
  } else if (typeof maxOrCallback === 'function') {
    min = 0;
    validateInteger(minOrMax, 'max');
    max = minOrMax as number;
    callback = maxOrCallback as RandomIntCallback;
  } else if (arguments.length === 2) {
    validateInteger(minOrMax, 'min');
    validateInteger(maxOrCallback, 'max');
    min = minOrMax as number;
    max = maxOrCallback as number;
  } else {
    min = 0;
    validateInteger(minOrMax, 'max');
    max = minOrMax;
  }

  if (min > max) {
    throw new ERR_OUT_OF_RANGE('min', 'min <= max', min);
  }

  if (callback !== undefined) {
    new Promise<number>((res) => {
      res(getRandomInt(min, max));
    }).then((n: number) => callback!(null, n), (err: any) => callback!(err));
    return;
  } else {
    return getRandomInt(min, max);
  }
}

export function randomUUID(options?: any) {
  // While we do not actually use the entropy cache, we go ahead and validate
  // the input parameters as Node.js does.
  if (options !== undefined) {
    validateObject(options, 'options', options);
    if (options.disableEntropyCache !== undefined) {
      validateBoolean(options.disableEntropyCache, 'options.disableEntropyCache');
    }
  }
  return crypto.randomUUID();
}

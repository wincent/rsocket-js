/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

'use strict';

import type {connect as SocketOptions} from 'net';
import type {DuplexConnection, Frame} from '../../ReactiveSocketTypes';
import type {ISubscriber, ISubscription} from '../../ReactiveStreamTypes';
import type {Encoders, TransportClient} from 'rsocket-core';

import net from 'net';
import {Future, Flowable} from 'rsocket-flowable';
import Deferred from 'fbjs/lib/Deferred';
import {
  createBuffer,
  deserializeFrames,
  serializeFrameWithLength,
} from 'rsocket-core';

/**
 * A TCP transport client for use in node environments.
 */
export default class RSocketTcpClient implements TransportClient {
  _encoders: ?Encoders<*>;
  _options: SocketOptions;

  constructor(options: SocketOptions, Encoders?: ?Encoders<*>) {
    this._encoders = Encoders;
    this._options = options;
  }

  connect(): Future<DuplexConnection> {
    return new Future(subscriber => {
      const socket = net.connect(this._options);
      const onError = error => {
        socket.removeAllListeners();
        subscriber.onError(error);
      };
      const onComplete = () => {
        socket.removeAllListeners();
        subscriber.onComplete(
          new TcpDuplexConnection(this._options, this._encoders, socket),
        );
      };
      const remove = () => {
        socket.removeAllListeners();
        socket.end();
      };

      subscriber.onSubscribe(remove);
      socket.once('error', onError);
      socket.once('connect', onComplete);
    });
  }
}

/**
 * @private
 */
class TcpDuplexConnection implements DuplexConnection {
  _active: boolean;
  _buffer: Buffer;
  _close: Deferred<void, Error>;
  _encoders: ?Encoders<*>;
  _receivers: Set<ISubscriber<Frame>>;
  _senders: Set<ISubscription>;
  _socket: net.Socket;
  _options: SocketOptions;

  constructor(
    options: SocketOptions,
    encoders: ?Encoders<*>,
    socket: net.Socket,
  ) {
    this._active = true;
    this._buffer = createBuffer(0);
    this._close = new Deferred();
    this._encoders = encoders;
    this._options = options;
    this._receivers = new Set();
    this._senders = new Set();
    this._socket = socket;

    this._socket.on('close', this.close);
    this._socket.on('data', this._handleData);
    this._socket.on('end', this._handleEnd);
    this._socket.on('error', this._handleError);
  }

  sendOne(frame: Frame): void {
    this._writeFrame(frame);
  }

  send(frames: Flowable<Frame>): void {
    let subscription;
    frames.subscribe({
      onComplete: () => {
        subscription && this._senders.delete(subscription);
      },
      onError: error => this._handleError(error),
      onNext: frame => this._writeFrame(frame),
      onSubscribe: _subscription => {
        subscription = _subscription;
        subscription.request(Number.MAX_SAFE_INTEGER);
        this._senders.add(subscription);
      },
    });
  }

  receive(): Flowable<Frame> {
    return new Flowable(subject => {
      subject.onSubscribe({
        cancel: () => {
          this._receivers.delete(subject);
        },
        request: () => {
          this._receivers.add(subject);
        },
      });
    });
  }

  close = (): void => {
    if (!this._active) {
      return;
    }
    this._active = false;
    this._close.resolve();
    this._receivers.forEach(subscriber => subscriber.onComplete());
    this._receivers.clear();
    this._senders.forEach(subscription => subscription.cancel());
    this._senders.clear();
    this._socket.removeAllListeners();
    this._socket.end();
  };

  onClose(): Promise<void> {
    return this._close.getPromise();
  }

  _handleData = (chunk: Buffer): void => {
    try {
      const frames = this._readFrames(chunk);
      frames.forEach(frame => {
        this._receivers.forEach(subscriber => subscriber.onNext(frame));
      });
    } catch (error) {
      this._handleError(error);
      this.close();
    }
  };

  _handleEnd = (): void => {
    this._handleError(
      new Error('RSocketTcpClient: Socket closed unexpectedly.'),
    );
  };

  _handleError = (error: Error): void => {
    this._receivers.forEach(subscriber => subscriber.onError(error));
    this.close();
  };

  _readFrames(chunk: Buffer): Array<Frame> {
    // Combine results from any partial frames received with new data and
    // extract any frames plus remaining bytes.
    const buffer = Buffer.concat([this._buffer, chunk]);
    const [frames, remaining] = deserializeFrames(buffer, this._encoders);
    this._buffer = remaining;
    return frames;
  }

  _writeFrame(frame: Frame): void {
    try {
      const buffer = serializeFrameWithLength(frame, this._encoders);
      this._socket.write(buffer);
    } catch (error) {
      this._handleError(error);
    }
  }
}

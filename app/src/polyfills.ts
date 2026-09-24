declare const global: any;

if (typeof global.process === 'undefined') {
  try {
  global.process = require('process');
  } catch {}
}

if (typeof global.Buffer === 'undefined') {
  try {
  global.Buffer = require('buffer').Buffer;
  } catch {}
}

if (typeof global.EventEmitter === 'undefined') {
  try {
  const events = require('events');
    if (events?.EventEmitter) {
  global.EventEmitter = events.EventEmitter;
    }
  } catch {}
}


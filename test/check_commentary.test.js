import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentaryDraft, summarize } from '../check.js';

const items = [
  { home: 'Ev', away: 'Dep', market: 'MS 1', prob: 0.6 },
  { home: 'A', away: 'B', market: 'KG Var', prob: 0.5 },
];

test('yorum birleşik olasılığı ve en zayıf seçimi söyler', () => {
  const summary = summarize(items);
  const text = commentaryDraft(items, summary);
  assert.match(text, /birleşik olasılığı %30/);
  assert.match(text, /En zayıf seçim A - B \(KG Var, %50\)/);
  assert.match(text, /Seçim puanı \d+\/100/);
});

test('tek seçimde en zayıf cümlesi yoktur', () => {
  const one = [items[0]];
  const text = commentaryDraft(one, summarize(one));
  assert.doesNotMatch(text, /En zayıf/);
});

test('yorumda bahis, oran ya da kupon sözcüğü geçmez', () => {
  const text = commentaryDraft(items, summarize(items));
  assert.doesNotMatch(text, /bahis|oran|kupon/i);
});

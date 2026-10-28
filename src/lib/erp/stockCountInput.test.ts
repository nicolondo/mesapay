import { describe, expect, it } from 'vitest';
import { countEntryFromBase, parseCountEntry, countEntriesFromBase, parseCountEntries, nextCountEntry } from './stockCountInput';

describe('count quantities survive save and reopen', () => {
  it.each(['mass','volume','count'] as const)('%s preserves base quantities through repeated edits', (kind) => {
    for(const original of [0,1,999,1000,1001,25940,2_000_000_000]) {
      let value = original;
      for(let pass=0;pass<4;pass++) {
        const entry = countEntryFromBase(value,kind);
        expect(parseCountEntry(entry.raw,kind,entry.unit)).toBe(original);
        value = parseCountEntry(entry.raw,kind,entry.unit) as number;
      }
    }
  });
  it('distinguishes not counted and counted zero',()=>{ expect(parseCountEntry('', 'count','un')).toBeNull();expect(parseCountEntry('0','count','un')).toBe(0);expect(countEntryFromBase(null,'mass').raw).toBe(''); });
  it('supports comma decimal units without multiplying on reopen',()=>{expect(parseCountEntry('25,94','count','un')).toBe(25940);expect(parseCountEntry('1,001','mass','kg')).toBe(1001);});
  it.each(['-1','Infinity','NaN','abc','2000000001'])('rejects invalid gram quantity %s',raw=>{expect(parseCountEntry(raw,'mass','g')).toBe('invalid');});
});

describe('separate quantities for repeated scans', () => {
  it('adds a blank quantity without overwriting the previous scan', () => {
    const entries = Object.freeze([Object.freeze({ raw: '12', unit: 'un' })]);
    expect(nextCountEntry(entries, 'count')).toEqual({ entries: [{ raw: '12', unit: 'un' }, { raw: '', unit: 'un' }], index: 1 });
    expect(entries).toEqual([{ raw: '12', unit: 'un' }]);
  });
  it('reuses an unfinished quantity instead of piling up empty fields', () => {
    expect(nextCountEntry([{ raw: '12', unit: 'un' }, { raw: '', unit: 'un' }], 'count')?.index).toBe(1);
    expect(nextCountEntry([], 'mass')).toEqual({ entries: [{ raw: '', unit: 'kg' }], index: 0 });
  });
  it('returns to an invalid quantity before adding another scan', () => {
    expect(nextCountEntry([{ raw: '12', unit: 'un' }, { raw: '0.0001', unit: 'un' }], 'count')?.index).toBe(1);
  });
  it('zero is completed, so another scan adds a new field', () => {
    expect(nextCountEntry([{ raw: '0', unit: 'un' }], 'count')?.index).toBe(1);
  });
  it('sums each quantity once in base units and skips unfinished blank fields', () => {
    expect(parseCountEntries([{ raw: '12', unit: 'un' }, { raw: '3', unit: 'un' }, { raw: '5', unit: 'un' }, { raw: '', unit: 'un' }], 'count'))
      .toEqual({ countedQty: 20000, countedParts: [12000, 3000, 5000] });
  });
  it('keeps not counted distinct from explicitly counted zero', () => {
    expect(parseCountEntries([{ raw: '', unit: 'un' }], 'count')).toEqual({ countedQty: null, countedParts: [] });
    expect(parseCountEntries([{ raw: '0', unit: 'un' }, { raw: '', unit: 'un' }], 'count')).toEqual({ countedQty: 0, countedParts: [0] });
  });
  it('converts mixed units and comma decimals before summing', () => {
    expect(parseCountEntries([{ raw: '1,25', unit: 'kg' }, { raw: '500', unit: 'g' }], 'mass')).toEqual({ countedQty: 1750, countedParts: [1250, 500] });
    expect(parseCountEntries([{ raw: '0.5', unit: 'L' }, { raw: '250', unit: 'ml' }], 'volume')).toEqual({ countedQty: 750, countedParts: [500, 250] });
  });
  it('rejects invalid parts and overflow of the aggregate', () => {
    expect(parseCountEntries([{ raw: '1', unit: 'un' }, { raw: '0.0001', unit: 'un' }], 'count')).toBe('invalid');
    expect(parseCountEntries([{ raw: '2000000', unit: 'un' }, { raw: '1', unit: 'un' }], 'count')).toBe('invalid');
    expect(parseCountEntries([{ raw: '2000000', unit: 'un' }, { raw: '0', unit: 'un' }], 'count')).toEqual({ countedQty: 2_000_000_000, countedParts: [2_000_000_000, 0] });
  });
  it('bounds scan fields while allowing completion of an existing blank slot', () => {
    const full = Array.from({ length: 200 }, () => ({ raw: '1', unit: 'un' }));
    expect(nextCountEntry(full, 'count')).toBeNull();
    expect(parseCountEntries([...full, { raw: '1', unit: 'un' }], 'count')).toBe('invalid');
    full[199] = { raw: '', unit: 'un' };
    expect(nextCountEntry(full, 'count')?.index).toBe(199);
  });
  it('restores every part after reopening and supports older aggregate-only counts', () => {
    expect(countEntriesFromBase(20000, 'count', [12000, 3000, 5000])).toEqual([{ raw: '12', unit: 'un' }, { raw: '3', unit: 'un' }, { raw: '5', unit: 'un' }]);
    expect(countEntriesFromBase(20000, 'count')).toEqual([{ raw: '20', unit: 'un' }]);
    expect(countEntriesFromBase(9000, 'count', [12000, 3000, 5000])).toEqual([{ raw: '9', unit: 'un' }]);
    expect(countEntriesFromBase(null, 'count', [12000])).toEqual([{ raw: '', unit: 'un' }]);
  });
  it.each(['mass', 'volume', 'count'] as const)('preserves %s partials through save/reopen', kind => {
    const parts = [0, 1, 999, 1001, 25940];
    const total = parts.reduce((sum, value) => sum + value, 0);
    expect(parseCountEntries(countEntriesFromBase(total, kind, parts), kind)).toEqual({ countedQty: total, countedParts: parts });
  });
});

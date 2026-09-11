import { describe, expect, it } from 'vitest';
import { countEntryFromBase, parseCountEntry } from './stockCountInput';

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

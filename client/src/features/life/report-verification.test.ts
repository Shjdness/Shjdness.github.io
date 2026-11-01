import {afterEach,expect,it,vi} from 'vitest';
import {captureReportVerification,pendingReportVerification,clearReportVerification} from './report-verification';
afterEach(()=>{clearReportVerification();vi.unstubAllGlobals();});
function fixture(hash:string,path='/life/reports'){
  const replaceState=vi.fn(),dispatchEvent=vi.fn();
  const value={location:{pathname:path,search:'?view=mail',hash},history:{state:{scroll:1},replaceState},dispatchEvent};vi.stubGlobal('window',value);return value;
}
it('removes an inbox fragment before retaining a memory-only proof and tolerates StrictMode repeated reads',()=>{
  const f=fixture('#verify='+'a'.repeat(43));captureReportVerification();
  expect(f.history.replaceState).toHaveBeenCalledWith({scroll:1},'','/life/reports?view=mail');
  expect(pendingReportVerification(1)).toBe('a'.repeat(43));expect(pendingReportVerification(1)).toBe('a'.repeat(43));
  expect(pendingReportVerification(2)).toBeNull();expect(pendingReportVerification(1)).toBeNull();
});
it('strips malformed verification fragments without retaining them and leaves unrelated anchors alone',()=>{
  const f=fixture('#verify=invalid-private-input');captureReportVerification();expect(f.history.replaceState).toHaveBeenCalledOnce();expect(pendingReportVerification(1)).toBeNull();
  const unrelated=fixture('#other-section');captureReportVerification();expect(unrelated.history.replaceState).not.toHaveBeenCalled();
  const otherPath=fixture('#verify='+'a'.repeat(43),'/blog');captureReportVerification();expect(otherPath.history.replaceState).not.toHaveBeenCalled();
});
it('does not retain a proof if URL cleanup fails and can explicitly erase a consumed proof',()=>{
  const f=fixture('#verify='+'b'.repeat(43));f.history.replaceState.mockImplementation(()=>{throw Error('Blocked');});
  captureReportVerification();expect(f.location.hash).toBe('');expect(pendingReportVerification(1)).toBeNull();
  fixture('#verify='+'c'.repeat(43));captureReportVerification();clearReportVerification();expect(pendingReportVerification(1)).toBeNull();
});

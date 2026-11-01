import {expect,it} from 'vitest';
import {reportMailVault,reportRecipient,maskedReportRecipient,reportVerificationToken,reportVerificationHash} from './report-mail-vault';
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1)));
const other=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+33)));

it('seals addresses with random nonces, account-bound authentication and independent fingerprint purpose',async()=>{
  const vault=await reportMailVault(secret),one=await vault.seal(1,' fixture+report@EXAMPLE.INVALID '),two=await vault.seal(1,'fixture+report@example.invalid');
  expect(one).not.toBe(two);expect(one).not.toContain('fixture');expect(await vault.open(1,one)).toBe('fixture+report@example.invalid');
  await expect(vault.open(2,one)).rejects.toThrow('cannot be decrypted');
  await expect((await reportMailVault(other)).open(1,one)).rejects.toThrow('cannot be decrypted');
  expect(await vault.fingerprint(1,'fixture+report@EXAMPLE.INVALID')).toBe(await vault.fingerprint(1,'fixture+report@example.invalid'));
  expect(await vault.fingerprint(1,'fixture+report@example.invalid')).not.toBe(await vault.fingerprint(2,'fixture+report@example.invalid'));
  expect(maskedReportRecipient('fixture@example.invalid')).toBe('f***@example.invalid');
  const damaged=JSON.parse(one);damaged.ciphertext=damaged.ciphertext.replace(/^./,damaged.ciphertext[0]==='A'?'B':'A');
  await expect(vault.open(1,JSON.stringify(damaged))).rejects.toThrow('cannot be decrypted');
});

it('rejects reused/invalid secrets, header injection and ambiguous recipient lists',async()=>{
  await expect(reportMailVault(secret,[secret])).rejects.toThrow('Independent');
  for(const key of ['', 'not-a-random-key',btoa('\0'.repeat(32))])await expect(reportMailVault(key)).rejects.toThrow('Independent');
  for(const email of ['a@example.invalid\r\nBcc: other@example.invalid','a@example.invalid,b@example.invalid','Name <a@example.invalid>','.a@example.invalid','a..b@example.invalid','a@-example.invalid','a@example..invalid'])expect(()=>reportRecipient(email)).toThrow('Invalid');
});

it('makes nonreversible-domain-separated verification digests without placing a token in stored output',async()=>{
  const one=await reportVerificationToken(),two=await reportVerificationToken();
  expect(one.token).toHaveLength(43);expect(one.hash).toMatch(/^[a-f0-9]{64}$/);expect(one.token).not.toBe(two.token);
  expect(await reportVerificationHash(one.token)).toBe(one.hash);expect(one.hash).not.toContain(one.token);
  await expect(reportVerificationHash('short')).rejects.toThrow('Invalid');
});

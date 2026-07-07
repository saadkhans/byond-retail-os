import {
  BcryptPasswordHasher,
  PasswordTooLongError,
} from './password-hasher';

describe('BcryptPasswordHasher', () => {
  const hasher = new BcryptPasswordHasher();

  it('never stores plaintext: the hash differs from the input and uses bcrypt format', async () => {
    const hash = await hasher.hash('correct horse battery staple');

    expect(hash).not.toContain('correct horse battery staple');
    expect(hash).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
  });

  it('verifies a correct password', async () => {
    const hash = await hasher.hash('s3cure-Pass!');
    await expect(hasher.verify('s3cure-Pass!', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash('s3cure-Pass!');
    await expect(hasher.verify('wrong-password', hash)).resolves.toBe(false);
  });

  it('produces unique salts: same input, different hashes', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('same-input'),
      hasher.hash('same-input'),
    ]);
    expect(first).not.toBe(second);
  });

  describe('equalizeTiming (adapter-owned)', () => {
    it('performs a real verify against an adapter-owned bcrypt hash', async () => {
      const verifySpy = jest.spyOn(hasher, 'verify');
      await hasher.equalizeTiming('some-candidate');

      expect(verifySpy).toHaveBeenCalledWith(
        'some-candidate',
        expect.stringMatching(/^\$2b\$12\$/),
      );
      verifySpy.mockRestore();
    });

    it('never throws — not even when verify fails internally', async () => {
      const verifySpy = jest
        .spyOn(hasher, 'verify')
        .mockRejectedValue(new Error('backend down'));
      await expect(hasher.equalizeTiming('x'.repeat(20))).resolves.toBeUndefined();
      verifySpy.mockRestore();
    });

    it('never throws for over-limit or odd inputs', async () => {
      await expect(hasher.equalizeTiming('a'.repeat(200))).resolves.toBeUndefined();
      await expect(hasher.equalizeTiming('')).resolves.toBeUndefined();
    });
  });

  describe('malformed stored hashes fail closed', () => {
    it.each(['not-a-bcrypt-hash', '', '$2b$xx$corrupted', '$1$legacy$hash'])(
      'verify against malformed hash %j resolves false, never throws',
      async (badHash) => {
        await expect(hasher.verify('any-password', badHash)).resolves.toBe(
          false,
        );
      },
    );
  });

  describe('bcrypt 72-byte limit', () => {
    it('accepts a password at exactly 72 bytes', async () => {
      const at72 = 'a'.repeat(72);
      const hash = await hasher.hash(at72);
      await expect(hasher.verify(at72, hash)).resolves.toBe(true);
    });

    it('rejects hashing a password over 72 bytes', async () => {
      await expect(hasher.hash('a'.repeat(73))).rejects.toThrow(
        PasswordTooLongError,
      );
    });

    it('measures BYTES, not characters: multibyte input over the limit is rejected', async () => {
      // 25 × '€' (3 bytes each) = 75 bytes in only 25 characters.
      await expect(hasher.hash('€'.repeat(25))).rejects.toThrow(
        PasswordTooLongError,
      );
    });

    it('never verifies an over-limit password — truncation collisions are closed', async () => {
      const base = 'a'.repeat(72);
      const hash = await hasher.hash(base);

      // Same first 72 bytes plus a suffix: raw bcrypt would truncate and
      // match; the guard refuses without doing bcrypt work.
      await expect(hasher.verify(`${base}-suffix`, hash)).resolves.toBe(false);
    });
  });
});

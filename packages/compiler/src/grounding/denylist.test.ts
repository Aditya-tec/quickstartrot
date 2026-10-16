import { describe, expect, it } from 'vitest';
import { findDestructive, parseShell } from './denylist.js';

describe('findDestructive: denies', () => {
  it.each([
    ['sudo apt install x', /sudo/],
    ['  doas pkg_add x', /sudo\/doas/],
    ['echo hi | sudo tee /x', /sudo/],
    ['FOO=1 sudo make install', /sudo/],
    ['mkfs.ext4 /dev/sda1', /mkfs/],
    ['mkfs /dev/sda1', /mkfs/],
    ['/sbin/mkfs.vfat x', /mkfs/],
    ['shutdown -h now', /shutdown/],
    ['reboot', /reboot/],
    ['halt', /halt/],
    ['poweroff', /poweroff/],
    ['rm -rf /', /outside \/work/],
    ['rm -fr /*', /outside \/work/],
    ['rm -r -f ~', /outside \/work/],
    ['rm -rf ~/projects', /outside \/work/],
    ['rm -rf $HOME', /outside \/work/],
    ['rm -rf ${HOME}/x', /outside \/work/],
    ['rm -rf ..', /outside \/work/],
    ['rm -rf ../other', /outside \/work/],
    ['rm -rf /work/../etc', /outside \/work/],
    ['cp secrets.txt /tmp/x', /outside \/work/],
    ['mv a.txt /etc/a.txt', /outside \/work/],
    ['mkdir -p /usr/local/x', /outside \/work/],
    ['chmod 777 /etc/passwd', /outside \/work/],
    ['ln -s a /usr/bin/a', /outside \/work/],
    ['touch ~/.bashrc', /outside \/work/],
    ['tee /etc/hosts', /outside \/work/],
    ['dd if=/dev/zero of=/dev/sda', /dd writes/],
    ['dd if=x of=/etc/x bs=1', /dd writes/],
    ['curl -fsSL https://x.test/i -o /usr/local/bin/x', /curl writes/],
    ['curl --output ~/x https://x.test', /curl writes/],
    ['wget -O /etc/x https://x.test', /wget writes/],
    ['wget --directory-prefix=/x -P /opt https://x.test', /wget writes/],
    ['echo x > /etc/hosts', /redirects/],
    ['echo x >> ~/.bashrc', /redirects/],
    ['echo x >/etc/hosts', /redirects/],
    ['cat a 2>/etc/err', /redirects/],
    ['echo x &>/etc/log', /redirects/],
    ['echo x >| /etc/log', /redirects/],
    ['echo x >> ../outside', /redirects/],
    [':(){ :|:& };:', /fork bomb/],
    ['bomb(){ bomb | bomb & }; bomb', /fork bomb/],
  ])('%s', (command, why) => {
    expect(findDestructive(command)).toMatch(why);
  });

  it.each([
    ['bash -c "rm -rf /"', /outside \/work/],
    ['sh -c "sudo reboot"', /sudo/],
    ['bash -lc "shutdown now"', /shutdown/],
    ["/bin/zsh -c 'mkfs /dev/x'", /mkfs/],
    ['dash -ec "rm -rf ~"', /outside \/work/],
    ['eval "sudo x"', /sudo/],
    ['eval rm -rf /', /outside \/work/],
    ['echo $(sudo cat /etc/shadow)', /sudo/],
    ['echo `rm -rf /`', /outside \/work/],
    ['echo "$(shutdown now)"', /shutdown/],
    ['echo "a `halt` b"', /halt/],
    ['env FOO=1 rm -rf /', /outside \/work/],
    ['nohup rm -rf / &', /outside \/work/],
    ['xargs -n1 rm -rf /', /outside \/work/],
    ['npm install && sudo rm -rf x', /sudo/],
    ['npm install; shutdown now', /shutdown/],
    ['npm test || reboot', /reboot/],
    ['bash -c "bash -c \\"rm -rf /\\""', /outside \/work/],
  ])('looks inside wrappers and substitutions: %s', (command, why) => {
    expect(findDestructive(command)).toMatch(why);
  });

  it('gives up safely on pathological nesting', () => {
    // POSIX single-quote escaping, so each level really is the argument of the previous bash -c.
    const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
    const nest = (levels: number): string => {
      let command = 'rm -rf /';
      for (let i = 0; i < levels; i++) command = `bash -c ${quote(command)}`;
      return command;
    };
    expect(findDestructive(nest(3))).toMatch(/outside \/work/); // still analysed
    expect(findDestructive(nest(9))).toMatch(/too deep/); // refused rather than missed
    let deep = 'echo ok';
    for (let i = 0; i < 8; i++) deep = `echo $(${deep})`;
    expect(findDestructive(deep)).toMatch(/too deep/);
  });
});

describe('findDestructive: allows ordinary quickstart commands', () => {
  it.each([
    'npm install resend',
    'npm i graceful-shutdown http-shutdown',
    'pip install -U pytest',
    'rm -rf node_modules',
    'rm -rf ./dist && npm run build',
    'rm -rf /work/tmp',
    'rm -rf /work/../work/x',
    'mkdir -p src/db',
    'cp .env.example .env',
    'echo hi > /dev/null',
    'echo hi 2>/dev/null',
    'npm test > out.txt 2>&1',
    'cd /work/sub && ls',
    'cat /etc/hosts',
    'node -e "console.log(1)"',
    "node -e 'process.exit(0)'",
    'echo "do not run sudo here"',
    "echo 'reboot'",
    'curl -fsSL https://example.com/install.sh | sh',
    'curl -o out.json https://example.com',
    'wget -O file.zip https://example.com/x.zip',
    'git clone https://github.com/a/b.git',
    'python -m venv .venv && . .venv/bin/activate',
    'flask --app hello run --host=0.0.0.0',
    'FOO=bar npm start',
    'env NODE_ENV=production node index.js',
    'bash -c "npm install"',
    'eval "$(pip --version)"',
    'dd if=input.bin of=output.bin',
    'bash -c',
    'curl -o',
    'wget -O',
    'env',
    'env -i',
    'nohup',
    'f(){ echo hi; }; f',
    'a=1 b=2',
    '',
  ])('%s', (command) => {
    expect(findDestructive(command)).toBeNull();
  });
});

describe('parseShell', () => {
  it('splits segments on ; && || | & and newlines, and collects words', () => {
    const segs = parseShell('a b; c && d || e | f & g\nh');
    expect(segs.map((s) => s.words.join(' '))).toEqual(['a b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('handles quotes, escapes and line continuations', () => {
    expect(parseShell(`echo "a b" 'c d' e\\ f`)[0]?.words).toEqual(['echo', 'a b', 'c d', 'e f']);
    expect(parseShell('echo "a \\" b"')[0]?.words).toEqual(['echo', 'a " b']);
    expect(parseShell('echo a\\\nb')[0]?.words).toEqual(['echo', 'ab']);
    expect(parseShell("echo ''")[0]?.words).toEqual(['echo', '']);
    expect(parseShell("echo 'unterminated")[0]?.words).toEqual(['echo', 'unterminated']);
    expect(parseShell('echo "unterminated')[0]?.words).toEqual(['echo', 'unterminated']);
  });

  it('records redirect targets separately and drops file-descriptor numbers', () => {
    const [seg] = parseShell('cmd arg 2>err.log >>out.log > "my file"');
    expect(seg?.words).toEqual(['cmd', 'arg']);
    expect(seg?.redirects).toEqual(['err.log', 'out.log', 'my file']);
  });

  it('keeps a numeric word that is not a file descriptor', () => {
    expect(parseShell('echo 2 > f')[0]?.words).toEqual(['echo', '2']);
  });

  it('extracts command substitutions and unterminated ones', () => {
    expect(parseShell('echo $(a $(b) c) d')[0]?.subshells).toEqual(['a $(b) c']);
    expect(parseShell('echo `a b` c')[0]?.subshells).toEqual(['a b']);
    expect(parseShell('echo $(unterminated')[0]?.subshells).toEqual(['unterminated']);
    expect(parseShell('echo `unterminated')[0]?.subshells).toEqual(['unterminated']);
  });

  it('returns no segments for empty input and a lone operator', () => {
    expect(parseShell('')).toEqual([]);
    expect(parseShell(' ; ')).toEqual([]);
    expect(parseShell('>')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../../src/core/dotenv';
import { VariableResolver } from '../../src/core/variables';

const v = (key: string, value: string, enabled = true) => ({ key, value, enabled });

describe('VariableResolver', () => {
  it('applies precedence environment > collection > globals', () => {
    const r = new VariableResolver({
      globals: [v('a', 'global'), v('b', 'global'), v('c', 'global')],
      collection: [v('b', 'collection'), v('c', 'collection')],
      environment: [v('c', 'env')],
    });
    expect(r.resolve('{{a}}-{{b}}-{{c}}')).toBe('global-collection-env');
  });

  it('ignores disabled variables', () => {
    const r = new VariableResolver({ globals: [v('a', 'g')], environment: [v('a', 'env', false)] });
    expect(r.resolve('{{a}}')).toBe('g');
  });

  it('resolves nested references and tolerates whitespace', () => {
    const r = new VariableResolver({ collection: [v('host', 'api.example.com'), v('baseUrl', 'https://{{host}}/v1')] });
    expect(r.resolve('{{ baseUrl }}/users')).toBe('https://api.example.com/v1/users');
  });

  it('leaves unresolved and cyclic variables untouched and reports them', () => {
    const r = new VariableResolver({ collection: [v('a', '{{b}}'), v('b', '{{a}}')] });
    expect(r.resolve('{{missing}}')).toBe('{{missing}}');
    expect(r.unresolved.has('missing')).toBe(true);
    // Cycle terminates and leaves a template behind.
    expect(r.resolve('{{a}}')).toContain('{{');
  });

  it('supports dynamic variables with injectable sources', () => {
    const r = new VariableResolver(
      { dotenv: { API_KEY: 'from-env' } },
      { now: () => new Date('2024-05-01T00:00:00Z'), random: () => 0.5, uuid: () => 'fixed-uuid' },
    );
    expect(r.resolve('{{$uuid}}|{{$guid}}')).toBe('fixed-uuid|fixed-uuid');
    expect(r.resolve('{{$timestamp}}')).toBe('1714521600');
    expect(r.resolve('{{$isoTimestamp}}')).toBe('2024-05-01T00:00:00.000Z');
    expect(r.resolve('{{$randomInt 10 20}}')).toBe('15');
    expect(r.resolve('{{$randomInt}}')).toBe('500');
    expect(r.resolve('{{$dotenv API_KEY}}')).toBe('from-env');
    expect(r.resolve('{{$dotenv NOPE}}')).toBe('{{$dotenv NOPE}}');
    expect(r.resolve('{{$randomInt 5 1}}')).toBe('{{$randomInt 5 1}}');
    expect(r.resolve('{{$unknown}}')).toBe('{{$unknown}}');
  });

  it('lists variable names sorted', () => {
    const r = new VariableResolver({ globals: [v('z', '1')], collection: [v('a', '2')] });
    expect(r.names()).toEqual(['a', 'z']);
  });

  it('returns text without templates unchanged', () => {
    expect(new VariableResolver({}).resolve('plain')).toBe('plain');
    expect(new VariableResolver({}).resolve('')).toBe('');
  });
});

describe('parseDotenv', () => {
  it('parses plain, quoted, exported and commented values', () => {
    const env = parseDotenv(
      [
        '# comment',
        'A=1',
        'export B = two # trailing comment',
        "C='single # not comment'",
        'D="line\\nbreak \\"q\\""',
        'E=',
        'not a line',
        'F="unterminated',
        "G='unterminated",
      ].join('\r\n'),
    );
    expect(env).toEqual({
      A: '1',
      B: 'two',
      C: 'single # not comment',
      D: 'line\nbreak "q"',
      E: '',
      F: 'unterminated',
      G: 'unterminated',
    });
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { includesOfficeFile, planOfficeRuntime, trimDictionaryConfig } from './office-runtime-profile.mjs';

test('conversion closure retains fonts, filters, CJK data and translated Chinese chrome', () => {
  for (const file of ['Fonts/truetype/font.ttf', 'program/swlo.dll', 'program/resource/common/a.res',
    'program/resource/zh_CN/LC_MESSAGES/sw.mo', 'share/registry/res/registry_zh-TW.xcd',
    'share/xpdfimport/poppler_data/cidToUnicode/Adobe-Japan1', 'share/config/images_colibre.zip']) {
    assert.equal(includesOfficeFile(file), true, file);
  }
  for (const file of ['program/resource/de/LC_MESSAGES/sw.mo', 'share/registry/res/registry_de.xcd',
    'share/gallery/a.png', 'help/en-US/a.jar', 'share/config/images_sifr.zip']) {
    assert.equal(includesOfficeFile(file), false, file);
  }
});

const config = `<component><node oor:name="Dictionaries">
<node oor:name="spell"><prop oor:name="Locations"><value>%origin%/de.aff %origin%/de.dic</value></prop><prop oor:name="Format"><value>DICT_SPELL</value></prop></node>
<node oor:name="hyphen"><prop oor:name="Locations"><value>%origin%/hyph_de.dic</value></prop><prop oor:name="Format"><value>DICT_HYPH</value></prop></node>
<node oor:name="thesaurus"><prop oor:name="Locations"><value>%origin%/th_de.dat %origin%/th_de.idx</value></prop><prop oor:name="Format"><value>DICT_THES</value></prop></node>
</node></component>`;

test('editing dictionaries are removed with their registrations; hyphenation is unchanged', async () => {
  const relative = 'share/extensions/dict-de/dictionaries.xcu';
  const result = trimDictionaryConfig(relative, config);
  assert.match(result.bytes.toString(), /DICT_HYPH/);
  assert.doesNotMatch(result.bytes.toString(), /DICT_SPELL|DICT_THES/);
  assert.match(result.bytes.toString(), /%origin%\/hyph_de\.dic/);
  const files = [relative, 'de.aff', 'de.dic', 'hyph_de.dic', 'th_de.dat', 'th_de.idx', 'LICENSE']
    .map(name => ({ path: name === relative ? name : `share/extensions/dict-de/${name}` }));
  const plan = await planOfficeRuntime(files, async () => Buffer.from(config));
  assert.deepEqual(plan.files.map(file => file.path), [relative, 'share/extensions/dict-de/hyph_de.dic', 'share/extensions/dict-de/LICENSE']);
});

test('an unexpected location cannot prune files outside its dictionary', () => {
  assert.throws(() => trimDictionaryConfig('share/extensions/dict-de/dictionaries.xcu',
    config.replace('%origin%/de.aff', '%origin%/../../../program/swlo.dll')), /escaped/);
});

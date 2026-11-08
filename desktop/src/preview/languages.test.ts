import { expect, it } from 'vitest';
import { SOURCE_LANGUAGES, sourceLanguageFor } from './languages';

it('covers the installed language inventory, compound names and common source families', () => {
  expect(SOURCE_LANGUAGES.length).toBeGreaterThanOrEqual(90);
  for (const [file, language] of [['main.py', 'python'], ['main.rs', 'rust'], ['main.go', 'go'], ['main.cs', 'csharp'], ['main.cpp', 'cpp'], ['module.mts', 'typescript'], ['component.tsx', 'typescript'], ['script.mjs', 'javascript'], ['query.graphql', 'graphql'], ['settings.yaml', 'yaml'], ['Dockerfile', 'dockerfile'], ['Gemfile', 'ruby'], ['.env.example', 'ini'], ['view.vue', 'html']]) {
    expect(sourceLanguageFor(`D:\\project\\${file}`).id, file).toBe(language);
  }
  expect(sourceLanguageFor('script', '#!/usr/bin/env python3\nprint("hello")').id).toBe('python');
  expect(sourceLanguageFor('readme.unknown', 'all content remains readable').id).toBe('plaintext');
  for (const [file, language] of [['CMakeLists.txt', 'cmake'], ['Makefile', 'makefile'], ['Cargo.toml', 'toml'], ['poetry.lock', 'toml'], ['solver.f90', 'fortran'], ['control.m', 'matlab'], ['build.zig', 'zig'], ['paper.tex', 'latex'], ['report.typ', 'typst']]) expect(sourceLanguageFor(file!).id, file).toBe(language);
  expect(sourceLanguageFor('view.m', '#import <Foundation/Foundation.h>\n@implementation View').id).toBe('objective-c');
});

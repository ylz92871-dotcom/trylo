import { expect, it } from 'vitest';
import { parsePersonSeatOutput } from './person-output';
import { inspectTeamRepresentation } from '../../../../new trylo cli/src/internal/protocol/team-representation';

it('V1 dispatch and Desktop projection agree on Person veto, missing sections and open questions', () => {
  const output = (veto: string, questions: string) => `### Intent\n- explicit: preserve scope\n### Veto\n${veto}\n### User questions\n${questions}\n### Representation notes\nnotes`;
  const fixtures = ['', 'unstructured', output('none', 'none'), output('`none`', '无'),
    output('explicit.acceptance is missing', 'none'), output('none', '- What is the expected format?'),
    output('', 'Empty'), output('none', '`none`'), `${output('none', 'none')}\n## **Veto**\nStop here`,
    output('none', 'none').replace('### Intent', 'Intent')];
  for (const fixture of fixtures) {
    const parsed = parsePersonSeatOutput(fixture);
    expect(inspectTeamRepresentation(fixture).ready).toBe(Boolean(parsed && !parsed.veto.active && parsed.userQuestions.length === 0));
  }
});

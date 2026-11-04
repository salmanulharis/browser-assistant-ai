import { describe, expect, it } from 'vitest';
import { buildActionTask, isPageActionRequest } from '@/utils/intent';

describe('page action intent', () => {
  it.each([
    'Fill this form with my details',
    'fill in the application form',
    'Please fill out the fields',
    'Can you put my email in the email field?',
    'could you please change the title to "Spring sale"',
    'Update the description with a short product summary',
    'Type Chennai into the city box',
    'Select Germany in the country dropdown',
    'fill them',
    'Fill it in please',
    'apply these',
    'ok, do it',
    'Now enter the details on the page',
    'I want you to write a bio in the description field',
  ])('treats %j as a page edit', (t) => expect(isPageActionRequest(t)).toBe(true));

  it.each([
    'What is this form for?',
    'How do I fill this form?',
    'Which fields are required?',
    'Summarize this page',
    'Write a cover letter for this job',
    'Explain the selected text simply',
    'Is the email field optional?',
    'Draft a reply using my writing style',
    '',
  ])('answers %j instead of editing', (t) => expect(isPageActionRequest(t)).toBe(false));

  it('adds the previous answer as reference data and respects the length limit', () => {
    expect(buildActionTask('fill them')).toBe('fill them');
    const t = buildActionTask('fill them', 'Name: Meera Iyer\nEmail: meera@example.com');
    expect(t).toContain('fill them');
    expect(t).toContain('Reference details');
    expect(t).toContain('meera@example.com');
    expect(buildActionTask('fill them', 'x'.repeat(10_000)).length).toBeLessThanOrEqual(3900);
  });
});

jest.mock('axios', () => ({ post: jest.fn() }));

const axios = require('axios');
const anthropic = require('../services/anthropic');

describe('Anthropic structured message client', () => {
  test('passes tools and tool choice through to the Messages API', async () => {
    axios.post.mockResolvedValue({ data: { content: [{ type: 'text', text: 'Done' }] } });
    const tools = [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }];
    const messages = [{ role: 'user', content: 'Find it' }];

    const data = await anthropic.createMessage({
      system: 'Use tools.',
      messages,
      tools,
      toolChoice: { type: 'auto', disable_parallel_tool_use: true },
      maxTokens: 321,
    });

    expect(data.content[0].text).toBe('Done');
    expect(axios.post.mock.calls[0][1]).toEqual(expect.objectContaining({
      model: anthropic.MODEL,
      max_tokens: 321,
      messages,
      tools,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    }));
  });
});

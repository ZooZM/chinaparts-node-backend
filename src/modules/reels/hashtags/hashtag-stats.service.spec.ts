import { HashtagStatsRepository } from './hashtag-stats.repository';
import { HashtagStatsService } from './hashtag-stats.service';

function setup() {
  const increment = jest.fn().mockResolvedValue(undefined);
  const decrement = jest.fn().mockResolvedValue(undefined);
  const findMatching = jest.fn().mockResolvedValue(['اطارات']);
  const service = new HashtagStatsService({
    increment,
    decrement,
    findMatching,
  } as unknown as HashtagStatsRepository);
  return { service, increment, decrement, findMatching };
}

describe('HashtagStatsService (research R9)', () => {
  it('counts a published reel once for each tag, using the first spelling as the display form', async () => {
    const { service, increment } = setup();

    await service.increment([
      { normalized: 'اطارات', display: 'إطارات' },
      { normalized: 'oilfilter', display: 'OilFilter' },
    ]);

    expect(increment).toHaveBeenCalledWith([
      { normalized: 'اطارات', display: 'إطارات' },
      { normalized: 'oilfilter', display: 'OilFilter' },
    ]);
  });

  it('counts a tag repeated on one reel once, and ignores an empty one', async () => {
    const { service, increment } = setup();

    await service.increment([
      { normalized: 'اطارات', display: 'إطارات' },
      { normalized: 'اطارات', display: 'اطارات' },
      { normalized: '', display: '' },
    ]);

    expect(increment).toHaveBeenCalledWith([
      { normalized: 'اطارات', display: 'إطارات' },
    ]);
  });

  it('counts down once for each distinct tag', async () => {
    const { service, decrement } = setup();

    await service.decrement(['a', 'b', 'a']);

    expect(decrement).toHaveBeenCalledWith(['a', 'b']);
  });

  it('finds the tags that contain the query, at most 200 by default', async () => {
    const { service, findMatching } = setup();

    await expect(service.findMatching('اطار')).resolves.toEqual(['اطارات']);

    expect(findMatching).toHaveBeenCalledWith('اطار', 200);
  });

  it('finds nothing for an empty query, without asking', async () => {
    const { service, findMatching } = setup();

    await expect(service.findMatching('   ')).resolves.toEqual([]);

    expect(findMatching).not.toHaveBeenCalled();
  });
});

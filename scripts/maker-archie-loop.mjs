import { createArchieLinuxCorpus } from './maker-archie-corpus.mjs';

export function attachArchieCorpus(runtime, corpus, { required = false } = {}) {
  if (!runtime || typeof runtime.run !== 'function') throw new Error('A runtime with run(input) is required.');
  if (!corpus || typeof corpus.recordMakerRun !== 'function') throw new Error('An Archie corpus with recordMakerRun(receipt) is required.');

  return Object.freeze({
    async run(input = {}) {
      const receipt = await runtime.run(input);
      try {
        const corpusRecord = await corpus.recordMakerRun(receipt, { input });
        return Object.freeze({ ...receipt, archie: corpusRecord });
      } catch (error) {
        if (required) throw error;
        return Object.freeze({
          ...receipt,
          archie: Object.freeze({
            schema: 'archie-linux-corpus-receipt/v1',
            status: 'failed',
            error: String(error?.message || error).slice(0, 2000)
          })
        });
      }
    }
  });
}

export function createArchieRuntime({ runtime, root, clock = Date.now, required = false } = {}) {
  const corpus = createArchieLinuxCorpus({ root, clock });
  return Object.freeze({
    corpus,
    runtime: attachArchieCorpus(runtime, corpus, { required })
  });
}

/** Public boundary for domain-owned experiments; central budgeting and persistence keep their existing owners. */
export type { TopicExperimentRegistration, TopicLearningConfiguration } from "./system.js";
export type { TopicComparisonSummary } from "./comparison-evidence.js";
export { topicProbeExpectationKeys } from "./execution-contract.js";
export type { TopicProbeExpectation, TopicCalibrationExpectation } from "./execution-contract.js";
export { matchesPairedTopicExperiment, topicMeasurements } from "./measurement-source.js";
export type { TopicPairedOutcome, TopicPairedProbe } from "./measurement-source.js";

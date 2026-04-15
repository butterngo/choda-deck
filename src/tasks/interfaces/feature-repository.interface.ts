import type { Feature, CreateFeatureInput, UpdateFeatureInput, DerivedProgress } from '../task-types'

export interface FeatureOperations {
  createFeature(input: CreateFeatureInput): Feature
  updateFeature(id: string, input: UpdateFeatureInput): Feature
  deleteFeature(id: string): void
  getFeature(id: string): Feature | null
  findFeatures(projectId: string): Feature[]
  findFeaturesByPhase(phaseId: string): Feature[]
  getFeatureProgress(featureId: string): DerivedProgress
}

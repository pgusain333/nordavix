import { apiClient } from "@/core/api/client"

export interface OnboardingStep {
  key:         string
  label:       string
  description: string
  done:        boolean
  cta:         string
  optional?:   boolean
}

export interface OnboardingStatus {
  steps:    OnboardingStep[]
  complete: boolean
  done:     number
  total:    number
}

async function getStatus(): Promise<OnboardingStatus> {
  const { data } = await apiClient.get<OnboardingStatus>("/api/onboarding/status")
  return data
}

export const onboardingApi = { getStatus }

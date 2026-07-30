/*
 * the shared vocabulary for talking about a project.
 *
 * four surfaces need to agree about what a project is called, which badge it
 * wears and which section it belongs to: the endeavours page, both card
 * components, and the contact form's inquiry banner. before this file the
 * contact page kept its own hand-written copy of the project list, so adding a
 * card silently produced a ?project= link that matched nothing and showed no
 * banner. it failed quietly, which is the worst way for a thing to fail.
 *
 * everything below derives from the one record in config.ts.
 */

import type { Project, ProjectStatus, ResearchArtifact } from "../types/config";
import { slugify } from "./helpers";
import { repoIsPublic } from "./release";

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  "private-beta": "private beta",
  "closed-dev-alpha": "closed dev alpha",
  "coming-soon": "coming soon",
  concept: "concept",
  parked: "parked",
};

// the dot means a person is working on this right now. that is the entire
// distinction "parked" exists to draw, so parked and concept never get one, and
// a card without a dot is making a quieter claim on purpose.
export const STATUS_IS_ACTIVE: Record<ProjectStatus, boolean> = {
  "private-beta": true,
  "closed-dev-alpha": true,
  "coming-soon": true,
  concept: false,
  parked: false,
};

// where a status lands when the record does not say. status and group stay
// independent axes: status is what the badge claims, group is which section the
// card sits in. a coming-soon project keeps its place among the shipped work
// because it has a real page to visit, and a parked one falls back to the
// concepts rail because nobody is currently at the wheel.
export const DEFAULT_GROUP: Record<ProjectStatus, "shipped" | "private" | "concept"> = {
  "private-beta": "private",
  "closed-dev-alpha": "private",
  "coming-soon": "shipped",
  concept: "concept",
  parked: "concept",
};

/**
 * let every gated card answer to its repository rather than to this file.
 *
 * a locked door overrules whatever the record hoped: private means "coming
 * soon" no matter what status said, and public clears the waiting badge without
 * anyone having to remember to. the probe itself fails closed, so an offline
 * build or a rate limit under-promises instead of sending someone to a 404.
 *
 * shared by every page that renders a card, because the home page and the
 * endeavours page disagreeing about whether neuron is out would be worse than
 * either of them being wrong on its own.
 */
export async function resolveGates(projects: Project[]): Promise<Project[]> {
  return Promise.all(
    projects.map(async (project) => {
      if (!project.gate) return project;
      const open = await repoIsPublic(project.gate);
      if (open) {
        return project.status === "coming-soon" ? { ...project, status: undefined } : project;
      }
      return { ...project, status: "coming-soon" as const };
    })
  );
}

export const projectSlug = (project: Project): string => project.slug ?? slugify(project.title);

export const groupOf = (project: Project): "shipped" | "private" | "concept" =>
  project.group ?? (project.status ? DEFAULT_GROUP[project.status] : "shipped");

/**
 * every id the contact form will answer to, mapped to the name it should show.
 *
 * artifact parts are in here too. wick and séance are halves of one research
 * artifact rather than projects, but they are linked as inquiries exactly the
 * same way, and leaving them out is how the hand-written map drifted in the
 * first place.
 */
export function inquiryLabels(
  projects: Project[],
  artifacts: ResearchArtifact[] = []
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const project of projects) labels[projectSlug(project)] = project.title;
  for (const artifact of artifacts) {
    for (const part of artifact.parts) labels[slugify(part.name)] = part.name;
  }
  return labels;
}

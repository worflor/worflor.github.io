export type NavBarLink = {
  title: string;
  url: string;
  external?: boolean;
};

export type GalleryImage = {
  src: string;
  alt: string;
};

export type SocialLink = {
  title: string;
  url: string;
  icon: string;
  external?: boolean;
};

export type Identity = {
  name: string;
  logo: string;
  email: string;
  github: string;
};

export type SEOInfo = {
  title: string;
  description: string;
  image: string;
};

export type HomePageContent = {
  seo: SEOInfo;
  role: string;
  description: string;
  socialLinks: SocialLink[];
  links: NavBarLink[];
};

export type ResumeItem = {
  title: string;
  company: {
    name: string;
    image: string;
    url: string;
  };
  date: string;
  summary?: string;
  tags?: string[];
};

export type AboutWorkContent = {
  description: string;
  items: ResumeItem[];
};

export type AboutPrinciple = {
  title: string;
  description: string;
};

export type AboutHighlight = {
  eyebrow: string;
  title: string;
  description: string;
  url: string;
  external?: boolean;
};

export type AboutPathItem = {
  era: string;
  title: string;
  description: string;
};

export type AboutPageContent = {
  seo: SEOInfo;
  subtitle: string;
  about: {
    description: string;
    images: GalleryImage[];
  };
  work: AboutWorkContent;
  connect: {
    description: string;
    links: SocialLink[];
  };
};

export type Project = {
  title: string;
  description: string;
  image?: string;
  // optional month label shown before the year, e.g. "May" -> "May 2026"
  month?: string;
  year: string;
  url: string;
  github?: string;
  // the dev-status badge shown on the card
  status?: "private-beta" | "concept" | "closed-dev-alpha";
  // which section the card lives in. its own axis: a closed-dev-alpha can be a
  // finished private tool ("private") or exploratory r&d ("concept"). defaults
  // are derived from status in projects.astro; set this only to override.
  group?: "private" | "concept";
};

// a published paper. everything renders from the arxiv id: the abstract, pdf,
// and doi links derive from it procedurally, and a live citation count fetches
// client-side (mirrors the github-stars auto-gen on ProjectCard).
export type Publication = {
  title: string;
  authors: string;
  // arxiv identifier, e.g. "2606.01668" — all links derive from this
  arxivId: string;
  // primary category, e.g. "math.CV"
  category?: string;
  // human-readable label, e.g. "June 2026"
  date: string;
  // one-line teaser (markdown allowed)
  teaser?: string;
};

// one half of a research artifact. each part renders with an inline immersive
// "blob" whose motion encodes its idea: condense (knowledge pulled together from
// nothing) or stream (a dense mass read out into the open).
export type ArtifactPart = {
  name: string;
  blurb: string; // markdown allowed
  status: string; // honest "where it's at now" line
  motion: "condense" | "stream";
};

// a thing built to the edge of an idea: real, runnable, deliberately unfinished.
// collapsed shows the takeaway; opened reveals the parts and how they relate.
export type ResearchArtifact = {
  title: string;
  subtitle?: string;
  takeaway: string; // the collapsed line (markdown allowed)
  parts: ArtifactPart[];
  duality: string; // how the parts answer each other (markdown allowed)
};

export type ProjectPageContent = {
  seo: SEOInfo;
  subtitle: string;
  projects: Project[];
  publications?: Publication[];
  artifacts?: ResearchArtifact[];
};

export type BlogPageContent = {
  seo: SEOInfo;
  subtitle: string;
};

export type ContactPageContent = {
  seo: SEOInfo;
  subtitle: string;
  sentMessage: string;
  placeholders: {
    name: string;
    email: string;
    message: string;
  };
  heyPlaceholders: {
    name: string;
    email: string;
    message: string;
  };
};

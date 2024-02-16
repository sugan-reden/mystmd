import fs from 'node:fs';
import { join } from 'node:path';
import type { CitationRenderer } from 'citation-js-utils';
import { getCitations } from 'citation-js-utils';
import { doi } from 'doi-utils';
import type { Link } from 'myst-spec';
import type { GenericNode, GenericParent } from 'myst-common';
import { fileWarn, toText, RuleId, plural } from 'myst-common';
import { selectAll } from 'unist-util-select';
import fetch from 'node-fetch';
import { computeHash, tic } from 'myst-cli-utils';
import type { Cite } from 'myst-spec-ext';
import type { SingleCitationRenderer } from './types.js';
import type { VFile } from 'vfile';
import type { ISession } from '../session/types.js';

function doiCacheFile(session: ISession, normalizedDoi: string) {
  const filename = `doi-${computeHash(normalizedDoi)}.bib`;
  const cacheFolder = join(session.buildPath(), 'cache');
  if (!fs.existsSync(cacheFolder)) fs.mkdirSync(cacheFolder, { recursive: true });
  return join(cacheFolder, filename);
}

export async function getDoiOrgBibtex(
  session: ISession,
  doiString: string,
): Promise<string | null> {
  const normalizedDoi = doi.normalize(doiString);
  if (!doi.validate(doiString) || !normalizedDoi) return null;
  const cachePath = doiCacheFile(session, normalizedDoi);
  if (fs.existsSync(cachePath)) {
    const bibtex = fs.readFileSync(cachePath).toString();
    session.log.debug(`Loaded cached reference information doi:${normalizedDoi}`);
    return bibtex;
  }
  const toc = tic();
  session.log.debug('Fetching DOI information from doi.org');
  const url = `https://doi.org/${normalizedDoi}`;
  const response = await fetch(url, {
    headers: [['Accept', 'application/x-bibtex']],
  }).catch(() => {
    session.log.debug(`Request to ${url} failed.`);
    return null;
  });
  if (!response || !response.ok) {
    session.log.debug(`doi.org fetch failed for ${doiString}}`);
    return null;
  }
  const bibtex = await response.text();
  session.log.debug(toc(`Fetched reference information doi:${normalizedDoi} in %s`));
  session.log.debug(`Saving doi to cache ${cachePath}`);
  fs.writeFileSync(cachePath, bibtex);
  return bibtex;
}

export async function getCitation(
  session: ISession,
  vfile: VFile,
  doiString: string,
  node: GenericNode,
): Promise<SingleCitationRenderer | null> {
  if (!doi.validate(doiString)) return null;
  const bibtex = await getDoiOrgBibtex(session, doiString);
  if (!bibtex) {
    fileWarn(vfile, `Could not find DOI from link: ${doiString} as ${doi.normalize(doiString)}`, {
      node,
      ruleId: RuleId.doiLinkValid,
    });
    return null;
  }
  const renderer = await getCitations(bibtex);
  const id = Object.keys(renderer)[0];
  const render = renderer[id];
  return { id, render };
}

/**
 * Find in-line DOIs and add them to the citation renderer
 */
export async function transformLinkedDOIs(
  session: ISession,
  vfile: VFile,
  mdast: GenericParent,
  doiRenderer: Record<string, SingleCitationRenderer>,
  path: string,
): Promise<CitationRenderer> {
  const toc = tic();
  const renderer: CitationRenderer = {};
  const linkedDois: Link[] = [];
  const citeDois: Cite[] = [];
  selectAll('link', mdast).forEach((node: GenericNode) => {
    const { url } = node as Link;
    if (!doi.validate(url)) return;
    linkedDois.push(node as Link);
  });
  selectAll('cite', mdast).forEach((node: GenericNode) => {
    const { label } = node as Cite;
    if (!doi.validate(label)) return;
    citeDois.push(node as Cite);
  });
  if (linkedDois.length === 0 && citeDois.length === 0) return renderer;
  session.log.debug(
    `Found ${plural('%s DOI(s)', linkedDois.length + citeDois.length)} to auto link.`,
  );
  let number = 0;
  await Promise.all([
    ...linkedDois.map(async (node) => {
      let cite: SingleCitationRenderer | null = doiRenderer[node.url];
      if (!cite) {
        cite = await getCitation(session, vfile, node.url, node);
        if (cite) number += 1;
        else return false;
      }
      doiRenderer[node.url] = cite;
      renderer[cite.id] = cite.render;
      const citeNode = node as unknown as Cite;
      citeNode.type = 'cite';
      citeNode.kind = 'narrative';
      citeNode.label = cite.id;
      if (doi.validate(toText(citeNode.children))) {
        // If the link text is the DOI, update with a citation in a following pass
        citeNode.children = [];
      }
      return true;
    }),
    ...citeDois.map(async (node) => {
      let cite: SingleCitationRenderer | null = doiRenderer[node.label];
      if (!cite) {
        cite = await getCitation(session, vfile, node.label, node);
        if (cite) number += 1;
        else return false;
      }
      doiRenderer[node.label] = cite;
      renderer[cite.id] = cite.render;
      node.label = cite.id;
      return true;
    }),
  ]);
  if (number > 0) {
    session.log.info(toc(`🪄  Linked ${number} DOI${number > 1 ? 's' : ''} in %s for ${path}`));
  }
  return renderer;
}

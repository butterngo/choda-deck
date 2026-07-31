// TASK-1553 — fixture reconstructed from INBOX-1642, the real Grab-text capture of
// https://cohere.com/blog/embed-4 that motivated this task. The prose is copied from
// that inbox item verbatim (curly quotes included) and wrapped in the structure the
// page actually uses: a cookie-consent banner, a products mega-menu, the article, and
// four footer link columns.
//
// Reconstructed rather than synthetic on purpose. AC-2/AC-3 assert against the text of
// the recorded defect, so a hand-invented "noisy page" would let the scorer pass by
// matching my imagination instead of the thing that actually broke.

const COOKIE_TEXT =
  'We and our partners use cookies, scripts and certain similar technologies (“Cookies”) ' +
  'to collect data from visitors to this site, including IP address, clicks, and other ' +
  'details about them and their use of the site and other sites. This helps us operate ' +
  'site features, identify visitors, understand use of our site, and provide personalized ' +
  'advertisements on and off our site, including ads based on your browsing habits. You ' +
  'can opt out of certain Cookies through the Cookie Settings link below. See our Privacy Policy.'

const FIRST_SENTENCE =
  'Today we’re releasing Embed 4: our latest state-of-the-art multimodal embedding model ' +
  'that enables enterprises to add frontier search and retrieval capabilities to AI ' +
  'applications — a necessity for businesses building assistants or agents that need to ' +
  'understand their business context.'

const LAST_SENTENCE =
  'Embed 4 is also available on Amazon SageMaker and for private deployment into any VPC ' +
  'or on-premise environment. To learn more, contact our sales team and find more ' +
  'technical details in our developer documentation.'

const TITLE = 'Introducing Embed 4: Multimodal search for business | Cohere Blog'
const ARTICLE_HEADING = 'Introducing Embed 4: Multimodal search for business'

// The mega-menu as INBOX-1642 recorded it: five top-level sections, each with its own
// sub-headings, product blurbs and link lists. The volume matters — this and the footer
// are most of the ~10KB the raw grab returned, so trimming them to a token nav would
// make the AC-3 size assertion measure a page that never existed.
const MEGA_MENU_ITEMS = [
  ['North', 'An enterprise-ready AI platform that powers modern workplace productivity'],
  ['Compass', 'An intelligent search and discovery system to surface business insights'],
  ['Command', 'High-performance models for agentic, multimodal, multilingual AI'],
  ['Transcribe', 'A speech recognition model for generating highly accurate audio transcripts'],
  ['North Mini Code', 'Agentic coding model, built for practical software engineering'],
  ['Embed', 'A leading multimodal search and retrieval tool'],
  ['Rerank', 'A powerful model that provides a semantic boost to search quality'],
  ['Model Vault', 'Your dedicated, secure model inference platform — managed by Cohere'],
  ['Cohere Labs', "Cohere's research lab that seeks to solve complex ML problems"],
  ['Customer Stories', 'Explore enterprise AI case studies and success stories']
]

const MEGA_MENU_SECTIONS = [
  ['Products', ['WORKPLACE SYSTEMS', 'GENERATIVE MODELS', 'ADVANCED RETRIEVAL MODELS', 'CUSTOMIZATION', 'PRICING', 'MODELS OVERVIEW']],
  ['Solutions', ['Technology', 'Financial Services', 'Healthcare and Life Sciences', 'Manufacturing', 'Energy and Utilities', 'Public Sector', 'Telecommunications', 'SECURITY', 'PRIVATE DEPLOYMENTS']],
  ['Research', ['Aya', 'Papers', 'Videos', 'Blog', 'Open Science Community', 'Scholars Program', 'Catalyst Grant Program', 'Global MMLU', 'The Leaderboard Illusion', 'Events']],
  ['Resources', ['Blog', 'Developers', 'Docs', 'Total Cost of AI Ownership', 'LLM University', 'Cookbooks', 'Discord', 'Events', 'On-Demand Events', 'Merch Store']],
  ['Company', ['About', 'Careers', 'Newsroom', 'Partners']]
]

// The recirculation + call-to-action block that sits between the article and the
// footer on the real page.
const READ_NEXT = [
  ['A day in the life of a wealth manager, with and without AI', 'JUL 27, 2026', '8 MIN READ'],
  ['Introducing North Automations: Intelligent workflow orchestration', 'JUL 27, 2026', '3 MIN READ'],
  ['Cohere and the University of Toronto partner to advance responsible AI adoption at scale', 'JUL 16, 2026', '1 MIN READ']
]

const NEWSLETTER_TEXT =
  'Enter your business email below to receive updates from Cohere. Please refer to our ' +
  'privacy policy for details or to contact us. You can unsubscribe at any time.'

const FOOTER_COLUMNS = [
  ['Products', ['North', 'Compass', 'Command', 'Transcribe', 'Embed', 'Rerank', 'Customization', 'Pricing']],
  ['Solutions', ['Technology', 'Energy and Utilities', 'Financial Services', 'Healthcare and Life Sciences', 'Manufacturing', 'Public Sector', 'Telecommunications']],
  ['Resources', ['Blog', 'Customer Stories', 'Developers', 'Events', 'Merch Store', 'LLM University', 'Documentation', 'Release Notes']],
  ['Company', ['About', 'Careers', 'Research', 'Newsroom', 'Partners', 'Security', 'Trust Center', 'Legal Center']]
]

const FEATURES = [
  ['State-of-the-art multimodality', 'Embed 4 is uniquely capable at accurately and quickly searching multifaceted documents such as intricate PDF reports and dynamic presentation slides.'],
  ['Breakthrough context length', 'Embed 4 can generate embeddings for documents up to 128K tokens (around 200 pages) in length such as annual financial reports.'],
  ['Leading multilingual capabilities', 'Embed 4 is multilingual across 100+ languages including key business languages such as Arabic, Japanese, Korean, and French.'],
  ['Enhancements for security-minded industries', 'Embed 4 is optimized with domain-specific understanding of data from regulated industries such as finance, healthcare, and manufacturing.']
]

function menuHtml() {
  const products = MEGA_MENU_ITEMS.map(
    ([name, blurb]) => `<li><a href="/${name.toLowerCase().replace(/\s+/g, '-')}">${name}</a><span>${blurb}</span></li>`
  ).join('')
  const sections = MEGA_MENU_SECTIONS.map(
    ([heading, items]) =>
      `<div class="menu-section"><h2>${heading}</h2><ul>${items
        .map((i) => `<li><a href="/${i.toLowerCase().replace(/\s+/g, '-')}">${i}</a></li>`)
        .join('')}</ul></div>`
  ).join('')
  return `
    <header class="site-header">
      <nav class="navbar" aria-label="Main">
        <a href="/">Cohere</a>
        <div class="megamenu">
          <h2>Products</h2>
          <ul>${products}</ul>
          ${sections}
        </div>
        <a href="/login">Sign in</a>
        <a href="/contact">Contact us</a>
      </nav>
    </header>`
}

function readNextHtml() {
  const cards = READ_NEXT.map(
    ([title, date, read]) =>
      `<li><a href="/blog/${title.slice(0, 12).toLowerCase().replace(/\s+/g, '-')}">${title}</a><span>${date}</span><span>${read}</span></li>`
  ).join('')
  return `
    <section class="recirc related">
      <h3>Read this next</h3>
      <ul>${cards}</ul>
      <div class="promo"><p>Ready to put AI to work?</p><a href="/demo">Request a demo</a></div>
      <div class="newsletter subscribe"><p>AI moves fast. We’ll keep you up to date with the latest.</p><p>${NEWSLETTER_TEXT}</p></div>
    </section>`
}

function footerHtml() {
  const cols = FOOTER_COLUMNS.map(
    ([heading, items]) =>
      `<div class="footer-col"><h3>${heading}</h3><ul>${items
        .map((i) => `<li><a href="/${i.toLowerCase().replace(/\s+/g, '-')}">${i}</a></li>`)
        .join('')}</ul></div>`
  ).join('')
  return `
    <footer class="site-footer">
      ${cols}
      <p>Cohere © 2026</p>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms of Use</a>
    </footer>`
}

function articleHtml() {
  const features = FEATURES.map(([name, body]) => `<li><strong>${name}:</strong> ${body}</li>`).join('')
  return `
    <main>
      <article>
        <header class="article-header">
          <h1>${ARTICLE_HEADING}</h1>
          <p class="dek">Embed 4 delivers state-of-the-art accuracy and efficiency, helping enterprises securely retrieve their multimodal data to build agentic AI applications.</p>
        </header>
        <p>${FIRST_SENTENCE}</p>
        <p>Embed 4 offers customers:</p>
        <ul>${features}</ul>
        <p>Existing embedding models fail to natively understand complex multimodal business materials, leading companies to develop cumbersome data pre-processing pipelines that only slightly improve accuracy. Embed 4 solves this problem, allowing enterprises and their employees to efficiently surface insights that are hidden within mountains of unsearchable information.</p>
        <blockquote>"Hunt Club's Atlas product lets customers navigate their sprawling professional networks and find talent within them. AI is essential in searching across complex candidate profiles and making sense of messy data to find ideal matches. Cohere's Embed 4 enables us to search these profiles more precisely, showing a +47% relative improvement over the already-strong performance of Embed 3. We are extremely impressed!" - James Kirk, VP of AI, Hunt Club</blockquote>
        <h2>Unlocking multimodal and multilingual search for global organizations</h2>
        <p>Embed 4 enables organizations to search their unstructured documents, where a large majority of their important data resides. It is uniquely capable of generating high-quality representations of complex mixed-modality documents – all within a unified vector. This capability additionally empowers businesses to build applications that can understand reference images alongside text questions, enabling users to use new search patterns to accelerate their productivity.</p>
        <p>In particular, Embed 4 excels in regulated industries such as finance, healthcare, and manufacturing. In addition to strong general business knowledge, the model is optimized with domain-specific understanding of these industries so that it can identify relevant insights within common documents such as:</p>
        <ul>
          <li><strong>Finance:</strong> investor presentations, annual financial reports, M&amp;A due diligence files</li>
          <li><strong>Healthcare:</strong> medical records, procedural charts, clinical trial reports</li>
          <li><strong>Manufacturing:</strong> product specification documents, repair guides, supply chain plans</li>
        </ul>
        <p>Each industry category represents a blend of public and proprietary benchmarks. Languages range from English only, monolingual multilingual, and cross-lingual multilingual. Task types ranged from text-only and text-to-PDF datasets. All dataset performance metrics are measured by NDCG@10. ColQwen is a multi-vector model. For embedding models that do not offer native image understanding, all mixed-modality datasets were parsed with a multimodal generative model before being embedded.</p>
        <p>Language should never be a barrier to accessing information. Embed 4 delivers leading multilingual understanding across 100+ languages such as Arabic, French, Japanese, and Korean. It also is capable of searching across languages, ensuring employees can find critical data regardless of the language it's stored in or the languages they speak.</p>
        <p>Business data tends to be imperfect. Certain documents have spelling mistakes, formatting issues, or have pages with landscape orientation that are meant to be in portrait. To ensure these issues don’t harm the accuracy of search results, Embed 4 was trained to be robust against noisy real-world data. It is also performant at searching over scanned documents and handwriting. These formats are common in legal paperwork, insurance invoices, and expense receipts. This capability eliminates the need for complex data preparations or pre-processing pipelines, saving businesses time and operational costs.</p>
        <blockquote>“Agora is an AI search engine that makes it easy to shop across 35,000 online stores in one place. We are blown away by Embed 4’s ability to accurately surface relevant products to search queries. E-commerce data is complex, containing images and multifaceted text descriptions. Being able to represent our products in a unified embedding makes our search faster and our internal tooling more efficient." - Param Jaggi, Founder, Agora</blockquote>
        <h2>Crucial foundation for agentic enterprise AI applications</h2>
        <p>AI systems must understand the context in which they operate to be useful. AI assistants deployed within businesses do this through a process called Retrieval-Augmented Generation (RAG). In essence, the generative AI model that powers the conversational experience will rely on a search engine – that is connected to proprietary company information – to source relevant information to user questions before responding. This improves the usefulness of answers and mitigates against hallucinations.</p>
        <p>Embed 4 is the optimal search engine for enterprise AI assistants and agents. In addition to strong accuracy across data types, the model delivers enterprise-grade efficiency. This allows it to scale to meet the demands of large organizations. Further, because high data storage costs lead to reduced ROI on technology investments, we designed Embed 4 to output compressed embeddings. This helps organizations to save up to 83% on storage costs while maintaining search accuracy.</p>
        <p>We are excited for businesses to use Embed 4 as the foundation of their search and retrieval pipelines, powering the next generation of AI applications across industries. Embed 4 also seamlessly integrates with North, our secure AI agents platform, by powering the semantic search capabilities of the end-to-end search system found in Compass.</p>
        <h2>Embed 4 is available today</h2>
        <p>Embed 4 is available today on Cohere’s platform and Microsoft Azure AI Foundry, giving enterprises two supported paths to production without standing up their own inference stack.</p>
        <p>${LAST_SENTENCE}</p>
      </article>
    </main>
    ${readNextHtml()}`
}

/** Full page HTML, as the browser would have it when Grab text ran. */
function html() {
  return `
    <div class="cookie-consent" id="cookie-banner">
      <p>${COOKIE_TEXT}</p>
      <button>Cookie settings</button>
    </div>
    ${menuHtml()}
    ${articleHtml()}
    ${footerHtml()}`
}

module.exports = {
  html,
  TITLE,
  ARTICLE_HEADING,
  COOKIE_TEXT,
  FIRST_SENTENCE,
  LAST_SENTENCE,
  NEWSLETTER_TEXT,
  MEGA_MENU_ITEMS,
  MEGA_MENU_SECTIONS,
  READ_NEXT,
  FOOTER_COLUMNS,
  FEATURES
}

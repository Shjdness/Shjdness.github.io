import "katex/dist/katex.min.css";
import React, { cloneElement, createContext, isValidElement, useContext, useEffect, useMemo, useRef } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  base16AteliersulphurpoolLight,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import gfm from "remark-gfm";
import remarkMermaid from "../remark/remarkMermaid";
import { remarkAlert } from "remark-github-blockquote-alert";
import remarkMath from "remark-math";
import Lightbox, { SlideImage } from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Download from "yet-another-react-lightbox/plugins/download";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { useColorMode } from "../utils/darkModeUtils";
import { markdownSchema } from "./markdown-schema";
import { isPrivateMediaPreview, markPrivateMediaPreviews, PrivateMediaImage, privateMediaIdFromImage, usePrivateMediaSession, type PrivateMediaContext } from "./private-media-image";

const LEGACY_ASSET_ORIGIN = "https://shjdbucket.shjdshy.cc";
const CURRENT_ASSET_ORIGIN =
  "https://pub-6b7dbaf76cfd4a81a8445a368adad8ad.r2.dev";

const normalizeAssetUrl = (url: string | undefined) =>
  url?.replace(LEGACY_ASSET_ORIGIN, CURRENT_ASSET_ORIGIN);


const countNewlinesBeforeNode = (text: string, offset: number) => {
  let newlinesBefore = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === "\n") {
      newlinesBefore++;
    } else {
      break;
    }
  }
  return newlinesBefore;
};

const isMarkdownImageLinkAtEnd = (text: string) => {
  const trimmed = text.trim();

  const match = trimmed.match(/(.*)(!\\[.*?\\]\\(.*?\\))$/s);

  if (match) {
    const [, beforeImage, _] = match;

    return beforeImage.trim().length === 0 || beforeImage.endsWith("\n");
  }

  return false;
};

const ImageContext = createContext<{
  content: string;
  privateMedia?: PrivateMediaContext;
  showPublicImage: (src: string) => void;
} | null>(null);

function MarkdownImage({ node, src, ...props }: React.ComponentProps<'img'> & ExtraProps) {
  const context = useContext(ImageContext);
  if (!context) return null;
  const { content, privateMedia, showPublicImage } = context;
  const offset = node?.position?.start.offset ?? 0;
  const previousContent = content.slice(0, offset);
  const rounded = countNewlinesBeforeNode(previousContent, offset) >= 1
    || previousContent.trim().length === 0 || isMarkdownImageLinkAtEnd(previousContent);
  const scale = rounded ? '0.75' : '0.5';
  const privateId = privateMediaIdFromImage(content, node?.position);
  const normalizedSrc = normalizeAssetUrl(src);
  return (
    <span className={rounded ? 'block w-full text-center my-4' : 'inline-block align-middle mx-1'}>
      {privateId ? (
        privateMedia && isPrivateMediaPreview(node)
          ? <PrivateMediaImage {...privateMedia} id={privateId} alt={props.alt} rounded={rounded} scale={scale} />
          : <span>{props.alt || '私密图片'}</span>
      ) : normalizedSrc ? (
        <img {...props} src={normalizedSrc} data-markdown-public-image="" onClick={() => showPublicImage(normalizedSrc)}
          className={`mx-auto ${rounded ? 'rounded-xl' : ''}`} style={{ zoom: scale }} />
      ) : props.alt ? <span>{props.alt}</span> : null}
    </span>
  );
}

export function Markdown({ content, privateMedia }: { content: string; privateMedia?: PrivateMediaContext }) {
  const colorMode = useColorMode();
  const [gallery, setGallery] = React.useState<{ slides: SlideImage[]; index: number }>();
  const markdown = useRef<HTMLDivElement>(null);
  const currentToken = usePrivateMediaSession(Boolean(privateMedia));
  const visiblePrivateMedia = privateMedia?.token && privateMedia.token === currentToken
    && (privateMedia.allowStaged || privateMedia.feedId !== undefined) ? privateMedia : undefined;
  const canPreviewPrivateMedia = Boolean(visiblePrivateMedia);
  useEffect(() => { setGallery(undefined); }, [content, currentToken]);
  const Content = useMemo(() => (
    <ReactMarkdown
      className="toc-content dark:text-neutral-300"
      remarkPlugins={[gfm, remarkMermaid, remarkMath, remarkAlert]}
      children={content}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSchema], rehypeKatex, ...(canPreviewPrivateMedia ? [markPrivateMediaPreviews(content)] : [])]}
      components={{
        img: MarkdownImage,
        code(props) {
          const [copied, setCopied] = React.useState(false);
          const { children, className, node, ...rest } = props;
          const match = /language-(\w+)/.exec(className || "");

          const curContent = content.slice(node?.position?.start.offset || 0);
          const isCodeBlock = curContent.trimStart().startsWith("```");

          const codeBlockStyle = {
            fontFamily: '"Fira Code", monospace',
            fontSize: "14px",
            fontVariantLigatures: "normal",
            WebkitFontFeatureSettings: '"liga" 1',
            fontFeatureSettings: '"liga" 1',
          };

          const inlineCodeStyle = {
            ...codeBlockStyle,
            fontSize: "13px",
          };

          const language = match ? match[1] : "";

          if (isCodeBlock) {
            return (
              <div className="relative group">
                <SyntaxHighlighter
                  PreTag="div"
                  className="rounded"
                  language={language}
                  style={
                    colorMode === "dark"
                      ? vscDarkPlus
                      : base16AteliersulphurpoolLight
                  }
                  wrapLongLines={true}
                  codeTagProps={{ style: codeBlockStyle }}
                >
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
                <button className="absolute top-1 right-1 px-2 py-1 bg-w rounded-md text-sm bg-hover select-none invisible group-hover:visible"
                  onClick={() => {
                    navigator.clipboard.writeText(String(children));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            );
          } else {
            return (
              <code
                {...rest}
                className={`bg-[#eff1f3] dark:bg-[#4a5061] h-[24px] px-[4px] rounded-md mx-[2px] py-[2px] text-neutral-800 dark:text-neutral-300 ${className || ""
                  }`}
                style={inlineCodeStyle}
              >
                {children}
              </code>
            );
          }
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="border-l-4 border-gray-300 dark:border-gray-500 pl-4 italic text-gray-500 dark:text-gray-400"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        em({ children, ...props }) {
          return (
            <em className="ml-[1px] mr-[4px]" {...props}>
              {children}
            </em>
          );
        },
        strong({ children, ...props }) {
          return (
            <strong className="mx-[1px]" {...props}>
              {children}
            </strong>
          );
        },

        ul({ children, className, ...props }) {
          const listClass = className?.includes("contains-task-list")
            ? "list-none pl-5"
            : "list-disc pl-5 mt-2";
          return (
            <ul className={listClass} {...props}>
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol className="list-decimal pl-5" {...props}>
              {children}
            </ol>
          );
        },
        li({ children, ...props }) {
          return (
            <li className="pl-2 py-1" {...props}>
              {children}
            </li>
          );
        },
        a({ children, ...props }) {
          return (
            <a
              className="text-[#0686c8] dark:text-[#2590f1] hover:underline"
              {...props}
            >
              {children}
            </a>
          );
        },
        h1({ children, ...props }) {
          return (
            <h1
              id={children?.toString()}
              className="text-3xl font-bold mt-4"
              {...props}
            >
              {children}
            </h1>
          );
        },
        h2({ children, ...props }) {
          return (
            <h2
              id={children?.toString()}
              className="text-2xl font-bold mt-4"
              {...props}
            >
              {children}
            </h2>
          );
        },
        h3({ children, ...props }) {
          return (
            <h3
              id={children?.toString()}
              className="text-xl font-bold mt-4"
              {...props}
            >
              {children}
            </h3>
          );
        },
        h4({ children, ...props }) {
          return (
            <h4
              id={children?.toString()}
              className="text-lg font-bold mt-4"
              {...props}
            >
              {children}
            </h4>
          );
        },
        h5({ children, ...props }) {
          return (
            <h5
              id={children?.toString()}
              className="text-base font-bold mt-4"
              {...props}
            >
              {children}
            </h5>
          );
        },
        h6({ children, ...props }) {
          return (
            <h6
              id={children?.toString()}
              className="text-sm font-bold mt-4"
              {...props}
            >
              {children}
            </h6>
          );
        },
        p({ children, node, ...props }) {
          return (
            <p className="mt-2 py-1 whitespace-pre-line" {...props}>
              {children}
            </p>
          );
        },
        hr({ children, ...props }) {
          return <hr className="my-4" {...props} />;
        },
        table: ({ node, ...props }) => <table className="table" {...props} />,
        th: ({ node, ...props }) => (
          <th className="px-4 py-2 border bg-gray-600" {...props} />
        ),
        td: ({ node, ...props }) => (
          <td className="px-4 py-2 border" {...props} />
        ),
        sup: ({ children, ...props }) => (
          <sup className="text-xs mr-[4px]" {...props}>
            {children}
          </sup>
        ),
        sub: ({ children, ...props }) => (
          <sub className="text-xs mr-[4px]" {...props}>
            {children}
          </sub>
        ),
        section({ children, ...props }) {
          if (props.hasOwnProperty("data-footnotes")) {
            props.className = `${props.className || ""} mt-8`.trim();
          }
          const modifiedChildren = React.Children.map(children, (child) => {
            if (isValidElement(child) && child.props.node.tagName === "ol") {
              return cloneElement(child, {
                ...child.props,
                className: "list-decimal px-10 text-sm text-[#6B7280]",
              } as React.HTMLAttributes<HTMLParagraphElement>);
            }
            return child;
          });
          return <section {...props}>{modifiedChildren}</section>;
        },
        div({ children, node, ...props }) {
          return <div {...props}>{children}</div>;
        },
      }}
    />), [content, colorMode, canPreviewPrivateMedia]);



  function show(src: string) {
    if (!markdown.current) return;
    const slides = Array.from(markdown.current.querySelectorAll("img[data-markdown-public-image]")).flatMap(image => {
      const url = image.getAttribute("src");
      return url ? [{
        src: url,
        alt: image.getAttribute("alt") || "",
        imageFit: "contain" as const,
        download: { url, filename: url.split("/").pop() || "" },
      }] : [];
    });
    const index = slides.findIndex(slide => slide.src === src);
    if (index >= 0) setGallery({ slides, index });
  }

  return (
    <>
      <ImageContext.Provider value={{ content, privateMedia: visiblePrivateMedia, showPublicImage: show }}>
        <div ref={markdown}>{Content}</div>
      </ImageContext.Provider>
      <Lightbox
        plugins={[Download, Zoom, Counter]}
        index={gallery?.index ?? 0}
        slides={gallery?.slides}
        open={Boolean(gallery)}
        close={() => setGallery(undefined)}
      />
    </>
  );
}

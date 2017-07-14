import React, { Component, PropTypes } from 'react';
import ReactDOMServer from 'react-dom/server';
import { Map, List, fromJS } from 'immutable';
import { reduce, mapValues } from 'lodash';
import cn from 'classnames';
import { Editor as SlateEditor, Html as SlateHtml, Raw as SlateRaw, Text as SlateText, Block as SlateBlock, Selection as SlateSelection} from 'slate';
import EditList from 'slate-edit-list';
import { markdownToHtml, htmlToMarkdown } from '../../unified';
import registry from '../../../../../lib/registry';
import { createAssetProxy } from '../../../../../valueObjects/AssetProxy';
import Toolbar from '../Toolbar/Toolbar';
import { Sticky } from '../../../../UI/Sticky/Sticky';
import styles from './index.css';

/**
 * Slate can serialize to html, but we persist the value as markdown. Serializing
 * the html to markdown on every keystroke is a big perf hit, so we'll register
 * functions to perform those actions only when necessary, such as after loading
 * and before persisting.
 */
registry.registerWidgetValueSerializer('markdown', {
  serialize: htmlToMarkdown,
  deserialize: markdownToHtml,
});

function processUrl(url) {
  if (url.match(/^(https?:\/\/|mailto:|\/)/)) {
    return url;
  }
  if (url.match(/^[^/]+\.[^/]+/)) {
    return `https://${ url }`;
  }
  return `/${ url }`;
}

const DEFAULT_NODE = 'paragraph';

function schemaWithPlugins(schema, plugins) {
  let nodeSpec = schema.nodeSpec;
  plugins.forEach((plugin) => {
    const attrs = {};
    plugin.get('fields').forEach((field) => {
      attrs[field.get('name')] = { default: null };
    });
    nodeSpec = nodeSpec.addToEnd(`plugin_${ plugin.get('id') }`, {
      attrs,
      group: 'block',
      parseDOM: [{
        tag: 'div[data-plugin]',
        getAttrs(dom) {
          return JSON.parse(dom.getAttribute('data-plugin'));
        },
      }],
      toDOM(node) {
        return ['div', { 'data-plugin': JSON.stringify(node.attrs) }, plugin.get('label')];
      },
    });
  });

  return new Schema({
    nodes: nodeSpec,
    marks: schema.markSpec,
  });
}

function createSerializer(schema, plugins) {
  const serializer = Object.create(defaultMarkdownSerializer);
  plugins.forEach((plugin) => {
    serializer.nodes[`plugin_${ plugin.get('id') }`] = (state, node) => {
      const toBlock = plugin.get('toBlock');
      state.write(`${ toBlock.call(plugin, node.attrs) }\n\n`);
    };
  });
  return serializer;
}

const BLOCK_TAGS = {
  p: 'paragraph',
  li: 'list-item',
  ul: 'bulleted-list',
  ol: 'numbered-list',
  blockquote: 'quote',
  pre: 'code',
  h1: 'heading-one',
  h2: 'heading-two',
  h3: 'heading-three',
  h4: 'heading-four',
  h5: 'heading-five',
  h6: 'heading-six',
}

const MARK_TAGS = {
  strong: 'bold',
  em: 'italic',
  u: 'underline',
  s: 'strikethrough',
  del: 'strikethrough',
  code: 'code'
}

const BLOCK_COMPONENTS = {
  'container': props => <div {...props.attributes}>{props.children}</div>,
  'paragraph': props => <p {...props.attributes}>{props.children}</p>,
  'list-item': props => <li {...props.attributes}>{props.children}</li>,
  'bulleted-list': props => <ul {...props.attributes}>{props.children}</ul>,
  'numbered-list': props => <ol {...props.attributes}>{props.children}</ol>,
  'quote': props => <blockquote {...props.attributes}>{props.children}</blockquote>,
  'code': props => <pre {...props.attributes}><code>{props.children}</code></pre>,
  'heading-one': props => <h1 {...props.attributes}>{props.children}</h1>,
  'heading-two': props => <h2 {...props.attributes}>{props.children}</h2>,
  'heading-three': props => <h3 {...props.attributes}>{props.children}</h3>,
  'heading-four': props => <h4 {...props.attributes}>{props.children}</h4>,
  'heading-five': props => <h5 {...props.attributes}>{props.children}</h5>,
  'heading-six': props => <h6 {...props.attributes}>{props.children}</h6>,
  'image': props => {
    const data = props.node && props.node.get('data');
    const src = data && data.get('src') || props.src;
    const alt = data && data.get('alt') || props.alt;
    return <img src={src} alt={alt} {...props.attributes}/>;
  },
};
const getShortcodeId = props => {
  if (props.node) {
    const result = props.node.getIn(['data', 'shortcode', 'shortcodeId']);
    return result || props.node.getIn(['data', 'shortcode']).shortcodeId;
  }
  return null;
}

const shortcodeStyles = {border: '2px solid black', padding: '8px', margin: '2px 0', cursor: 'pointer'};

const NODE_COMPONENTS = {
  ...BLOCK_COMPONENTS,
  'link': props => {
    const href = props.node && props.node.getIn(['data', 'href']) || props.href;
    return <a href={href} {...props.attributes}>{props.children}</a>;
  },
  'shortcode': props => {
    const { attributes, node, state: editorState } = props;
    const isSelected = editorState.selection.hasFocusIn(node);
    return (
      <div
        className={cn(styles.shortcode, { [styles.shortcodeSelected]: isSelected })}
        {...attributes}
        draggable
      >
        {getShortcodeId(props)}
      </div>
    );
  },
};

const MARK_COMPONENTS = {
  bold: props => <strong>{props.children}</strong>,
  italic: props => <em>{props.children}</em>,
  underlined: props => <u>{props.children}</u>,
  strikethrough: props => <s>{props.children}</s>,
  code: props => <code>{props.children}</code>,
};

const RULES = [
  {
    deserialize(el, next) {
      const shortcodeId = el.attribs && el.attribs['data-ncp'];
      if (!shortcodeId) {
        return;
      }
      const plugin = registry.getEditorComponents().get(shortcodeId);
      if (!plugin) {
        return;
      }
      const shortcodeData = Map(el.attribs).reduce((acc, value, key) => {
        if (key.startsWith('data-ncp-')) {
          const dataKey = key.slice('data-ncp-'.length).toLowerCase();
          if (dataKey) {
            return acc.set(dataKey, value);
          }
        }
        return acc;
      }, Map({ shortcodeId }));

      const result = {
        kind: 'block',
        isVoid: true,
        type: 'shortcode',
        data: { shortcode: shortcodeData },
      };
      return result;
    },
    serialize(entity, children) {
      if (entity.type !== 'shortcode') {
        return;
      }

      const data = Map(entity.data.get('shortcode'));
      const shortcodeId = data.get('shortcodeId');
      const plugin = registry.getEditorComponents().get(shortcodeId);
      const dataAttrs = data.delete('shortcodeId').mapKeys(key => `data-ncp-${key}`).set('data-ncp', shortcodeId);
      const preview = plugin.toPreview(data.toJS());
      const component = typeof preview === 'string'
        ? <div { ...dataAttrs.toJS() } dangerouslySetInnerHTML={ { __html: preview } }></div>
        : <div { ...dataAttrs.toJS() }>{preview}</div>;
      return component;
    },
  },
  {
    deserialize(el, next) {
      const block = BLOCK_TAGS[el.tagName]
      if (!block) return
      return {
        kind: 'block',
        type: block,
        nodes: next(el.children)
      }
    },
    serialize(entity, children) {
      if (['bulleted-list', 'numbered-list'].includes(entity.type)) {
        return;
      }
      if (entity.kind !== 'block') {
        return;
      }
      const component = BLOCK_COMPONENTS[entity.type]
      if (!component) {
        return;
      }
      return component({ children });
    }
  },
  {
    deserialize(el, next) {
      const mark = MARK_TAGS[el.tagName]
      if (!mark) return
      return {
        kind: 'mark',
        type: mark,
        nodes: next(el.children)
      }
    },
    serialize(entity, children) {
      if (entity.kind !== 'mark') {
        return;
      }
      const component = MARK_COMPONENTS[entity.type]
      if (!component) {
        return;
      }
      return component({ children });
    }
  },
  {
    // Special case for code blocks, which need to grab the nested children.
    deserialize(el, next) {
      if (el.tagName != 'pre') return
      const code = el.children[0]
      const children = code && code.tagName == 'code'
        ? code.children
        : el.children

      return {
        kind: 'block',
        type: 'code',
        nodes: next(children)
      }
    },
  },
  {
    deserialize(el, next) {
      if (el.tagName != 'img') return
      return {
        kind: 'inline',
        type: 'image',
        isVoid: true,
        nodes: [],
        data: {
          src: el.attribs.src,
          alt: el.attribs.alt,
        }
      }
    },
    serialize(entity, children) {
      if (entity.type !== 'image') {
        return;
      }
      const data = entity.get('data');
      const props = {
        src: data.get('src'),
        alt: data.get('alt'),
      };
      const result = NODE_COMPONENTS.image(props);
      return result;
    }
  },
  {
    // Special case for links, to grab their href.
    deserialize(el, next) {
      if (el.tagName != 'a') return
      return {
        kind: 'inline',
        type: 'link',
        nodes: next(el.children),
        data: {
          href: el.attribs.href
        }
      }
    },
    serialize(entity, children) {
      if (entity.type !== 'link') {
        return;
      }
      const data = entity.get('data');
      const props = {
        href: data.get('href'),
        attributes: data.get('attributes'),
        children,
      };
      return NODE_COMPONENTS.link(props);
    }
  },
  {
    serialize(entity, children) {
      if (!['bulleted-list', 'numbered-list'].includes(entity.type)) {
        return;
      }
      return NODE_COMPONENTS[entity.type]({ children });
    }
  }

]

const serializer = new SlateHtml({ rules: RULES });

const SoftBreak = (options = {}) => ({
  onKeyDown(e, data, state) {
    if (data.key != 'enter') return;
    if (options.shift && e.shiftKey == false) return;

    const { onlyIn, ignoreIn, closeAfter, unwrapBlocks, defaultBlock = 'paragraph' } = options;
    const { type, nodes } = state.startBlock;
    if (onlyIn && !onlyIn.includes(type)) return;
    if (ignoreIn && ignoreIn.includes(type)) return;

    const shouldClose = nodes.last().characters.takeLast(closeAfter).every(c => c.text === '\n');
    if (closeAfter && shouldClose) {
      const trimmed = state.transform().deleteBackward(closeAfter);
      const unwrapped = unwrapBlocks
        ? unwrapBlocks.reduce((acc, blockType) => acc.unwrapBlock(blockType), trimmed)
        : trimmed;
      return unwrapped.insertBlock(defaultBlock).apply();
    }

    return state.transform().insertText('\n').apply();
  }
});

const BackspaceCloseBlock = (options = {}) => ({
  onKeyDown(e, data, state) {
    if (data.key != 'backspace') return;

    const { defaultBlock = 'paragraph', ignoreIn, onlyIn } = options;
    const { startBlock } = state;
    const { type } = startBlock;

    if (onlyIn && !onlyIn.includes(type)) return;
    if (ignoreIn && ignoreIn.includes(type)) return;

    const characters = startBlock.getFirstText().characters;
    const isEmpty = !characters || characters.isEmpty();

    if (isEmpty) {
      return state.transform().insertBlock(defaultBlock).focus().apply();
    }
  }
});

const slatePlugins = [
  SoftBreak({ ignoreIn: ['paragraph', 'list-item', 'numbered-list', 'bulleted-list'], closeAfter: 1 }),
  BackspaceCloseBlock({ ignoreIn: ['paragraph', 'list-item', 'bulleted-list', 'numbered-list'] }),
  EditList({ types: ['bulleted-list', 'numbered-list'], typeItem: 'list-item' }),
];

export default class Editor extends Component {
  constructor(props) {
    super(props);
    const plugins = registry.getEditorComponents();
    // Wrap value in div to ensure against trailing text outside of top level html element
    const initialValue = this.props.value ? `<div>${this.props.value}</div>` : '<p></p>';
    this.state = {
      editorState: serializer.deserialize(initialValue),
      schema: {
        nodes: NODE_COMPONENTS,
        marks: MARK_COMPONENTS,
        rules: [
          {
            match: object => object.kind === 'document',
            validate: doc => {
              const blocks = doc.getBlocks();
              const firstBlock = blocks.first();
              const lastBlock = blocks.last();
              const firstBlockIsVoid = firstBlock.isVoid;
              const lastBlockIsVoid = lastBlock.isVoid;

              if (firstBlockIsVoid || lastBlockIsVoid) {
                return { blocks, firstBlock, lastBlock, firstBlockIsVoid, lastBlockIsVoid };
              }
            },
            normalize: (transform, doc, { blocks, firstBlock, lastBlock, firstBlockIsVoid, lastBlockIsVoid }) => {
              const block = SlateBlock.create({
                type: 'paragraph',
                nodes: [SlateText.createFromString('')],
              });
              if (firstBlockIsVoid) {
                const { key } = transform.state.document;
                transform.insertNodeByKey(key, 0, block);
              }
              if (lastBlockIsVoid) {
                const { key, nodes } = transform.state.document;
                transform.insertNodeByKey(key, nodes.size, block);
              }
              return transform;
            },
          }
        ],
      },
      plugins,
    };
  }

  handlePaste = (e, data, state) => {
    if (data.type !== 'html' || data.isShift) {
      return;
    }
    const markdown = htmlToMarkdown(data.html);
    const html = markdownToHtml(markdown);
    const fragment = serializer.deserialize(html).document;
    return state.transform().insertFragment(fragment).apply();
  }

  handleDocumentChange = (doc, editorState) => {
    const html = serializer.serialize(editorState);
    this.props.onChange(html);
  };

  hasMark = type => this.state.editorState.marks.some(mark => mark.type === type);
  hasBlock = type => this.state.editorState.blocks.some(node => node.type === type);

  handleKeyDown = (e, data, state) => {
    if (!data.isMod) {
      return;
    }
    const marks = {
      b: 'bold',
      i: 'italic',
      u: 'underlined',
      s: 'strikethrough',
      '`': 'code',
    };

    const mark = marks[data.key];

    if (mark) {
      state = state.transform().toggleMark(mark).apply();
    }
    return;
  };

  handleMarkClick = (event, type) => {
    event.preventDefault();
    const resolvedState = this.state.editorState.transform().focus().toggleMark(type).apply();
    this.ref.onChange(resolvedState);
    this.setState({ editorState: resolvedState });
  };

  handleBlockClick = (event, type) => {
    event.preventDefault();
    let { editorState } = this.state;
    const transform = editorState.transform().focus();
    const doc = editorState.document;
    const isList = this.hasBlock('list-item')

    // Handle everything except list buttons.
    if (!['bulleted-list', 'numbered-list'].includes(type)) {
      const isActive = this.hasBlock(type);
      const transformed = transform.setBlock(isActive ? DEFAULT_NODE : type);

      if (isList) {
        transformed
          .unwrapBlock('bulleted-list')
          .unwrapBlock('numbered-list');
      }
    }

    // Handle the extra wrapping required for list buttons.
    else {
      const isType = editorState.blocks.some(block => {
        return !!doc.getClosest(block.key, parent => parent.type === type);
      });

      if (isList && isType) {
        transform
          .setBlock(DEFAULT_NODE)
          .unwrapBlock('bulleted-list')
          .unwrapBlock('numbered-list');
      } else if (isList) {
        transform
          .unwrapBlock(type === 'bulleted-list' ? 'numbered-list' : 'bulleted-list')
          .wrapBlock(type);
      } else {
        transform
          .setBlock('list-item')
          .wrapBlock(type);
      }
    }

    const resolvedState = transform.apply();
    this.ref.onChange(resolvedState);
    this.setState({ editorState: resolvedState });
  };


  handleLink = () => {
    let url = null;
    if (!markActive(this.view.state, this.state.schema.marks.link)) {
      url = prompt('Link URL:'); // eslint-disable-line no-alert
    }
    const command = toggleMark(this.state.schema.marks.link, { href: url ? processUrl(url) : null });
    command(this.view.state, this.handleAction);
  };

  handlePluginSubmit = (plugin, data) => {
    const { editorState } = this.state;
    const markdown = plugin.toBlock(data.toJS());
    const html = markdownToHtml(markdown);
    const block = serializer.deserialize(html).document.getBlocks().first();
    const resolvedState = editorState.transform().insertBlock(block).apply();
    this.ref.onChange(resolvedState);
    this.setState({ editorState: resolvedState });
  };

  handleToggle = () => {
    this.props.onMode('raw');
  };

  getButtonProps = (type, isBlock) => {
    const handler = isBlock ? this.handleBlockClick: this.handleMarkClick;
    const isActive = isBlock ? this.hasBlock : this.hasMark;
    return { onAction: e => handler(e, type), active: isActive(type) };
  };

  render() {
    const { onAddAsset, onRemoveAsset, getAsset } = this.props;
    const { plugins, selectionPosition, dragging } = this.state;

    return (
      <div className={styles.editor}>
        <Sticky
          className={styles.editorControlBar}
          classNameActive={styles.editorControlBarSticky}
          fillContainerWidth
        >
          <Toolbar
            selectionPosition={selectionPosition}
            buttons={{
              bold: this.getButtonProps('bold'),
              italic: this.getButtonProps('italic'),
              code: this.getButtonProps('code'),
              link: this.getButtonProps('link'),
              h1: this.getButtonProps('heading-one', true),
              h2: this.getButtonProps('heading-two', true),
              list: this.getButtonProps('bulleted-list', true),
              listNumbered: this.getButtonProps('numbered-list', true),
              codeBlock: this.getButtonProps('code', true),
            }}
            onToggleMode={this.handleToggle}
            plugins={plugins}
            onSubmit={this.handlePluginSubmit}
            onAddAsset={onAddAsset}
            onRemoveAsset={onRemoveAsset}
            getAsset={getAsset}
          />
        </Sticky>
        <SlateEditor
          className={styles.slateEditor}
          state={this.state.editorState}
          schema={this.state.schema}
          plugins={slatePlugins}
          onChange={editorState => this.setState({ editorState })}
          onDocumentChange={this.handleDocumentChange}
          onKeyDown={this.onKeyDown}
          onPaste={this.handlePaste}
          ref={ref => this.ref = ref}
          spellCheck
        />
      </div>
    );
  }
}

Editor.propTypes = {
  onAddAsset: PropTypes.func.isRequired,
  onRemoveAsset: PropTypes.func.isRequired,
  getAsset: PropTypes.func.isRequired,
  onChange: PropTypes.func.isRequired,
  onMode: PropTypes.func.isRequired,
  value: PropTypes.node,
};

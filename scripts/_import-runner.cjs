var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/kind-of/index.js
var require_kind_of = __commonJS({
  "node_modules/kind-of/index.js"(exports2, module2) {
    var toString = Object.prototype.toString;
    module2.exports = function kindOf(val) {
      if (val === void 0) return "undefined";
      if (val === null) return "null";
      var type = typeof val;
      if (type === "boolean") return "boolean";
      if (type === "string") return "string";
      if (type === "number") return "number";
      if (type === "symbol") return "symbol";
      if (type === "function") {
        return isGeneratorFn(val) ? "generatorfunction" : "function";
      }
      if (isArray(val)) return "array";
      if (isBuffer(val)) return "buffer";
      if (isArguments(val)) return "arguments";
      if (isDate(val)) return "date";
      if (isError(val)) return "error";
      if (isRegexp(val)) return "regexp";
      switch (ctorName(val)) {
        case "Symbol":
          return "symbol";
        case "Promise":
          return "promise";
        // Set, Map, WeakSet, WeakMap
        case "WeakMap":
          return "weakmap";
        case "WeakSet":
          return "weakset";
        case "Map":
          return "map";
        case "Set":
          return "set";
        // 8-bit typed arrays
        case "Int8Array":
          return "int8array";
        case "Uint8Array":
          return "uint8array";
        case "Uint8ClampedArray":
          return "uint8clampedarray";
        // 16-bit typed arrays
        case "Int16Array":
          return "int16array";
        case "Uint16Array":
          return "uint16array";
        // 32-bit typed arrays
        case "Int32Array":
          return "int32array";
        case "Uint32Array":
          return "uint32array";
        case "Float32Array":
          return "float32array";
        case "Float64Array":
          return "float64array";
      }
      if (isGeneratorObj(val)) {
        return "generator";
      }
      type = toString.call(val);
      switch (type) {
        case "[object Object]":
          return "object";
        // iterators
        case "[object Map Iterator]":
          return "mapiterator";
        case "[object Set Iterator]":
          return "setiterator";
        case "[object String Iterator]":
          return "stringiterator";
        case "[object Array Iterator]":
          return "arrayiterator";
      }
      return type.slice(8, -1).toLowerCase().replace(/\s/g, "");
    };
    function ctorName(val) {
      return typeof val.constructor === "function" ? val.constructor.name : null;
    }
    function isArray(val) {
      if (Array.isArray) return Array.isArray(val);
      return val instanceof Array;
    }
    function isError(val) {
      return val instanceof Error || typeof val.message === "string" && val.constructor && typeof val.constructor.stackTraceLimit === "number";
    }
    function isDate(val) {
      if (val instanceof Date) return true;
      return typeof val.toDateString === "function" && typeof val.getDate === "function" && typeof val.setDate === "function";
    }
    function isRegexp(val) {
      if (val instanceof RegExp) return true;
      return typeof val.flags === "string" && typeof val.ignoreCase === "boolean" && typeof val.multiline === "boolean" && typeof val.global === "boolean";
    }
    function isGeneratorFn(name, val) {
      return ctorName(name) === "GeneratorFunction";
    }
    function isGeneratorObj(val) {
      return typeof val.throw === "function" && typeof val.return === "function" && typeof val.next === "function";
    }
    function isArguments(val) {
      try {
        if (typeof val.length === "number" && typeof val.callee === "function") {
          return true;
        }
      } catch (err) {
        if (err.message.indexOf("callee") !== -1) {
          return true;
        }
      }
      return false;
    }
    function isBuffer(val) {
      if (val.constructor && typeof val.constructor.isBuffer === "function") {
        return val.constructor.isBuffer(val);
      }
      return false;
    }
  }
});

// node_modules/is-extendable/index.js
var require_is_extendable = __commonJS({
  "node_modules/is-extendable/index.js"(exports2, module2) {
    "use strict";
    module2.exports = function isExtendable(val) {
      return typeof val !== "undefined" && val !== null && (typeof val === "object" || typeof val === "function");
    };
  }
});

// node_modules/extend-shallow/index.js
var require_extend_shallow = __commonJS({
  "node_modules/extend-shallow/index.js"(exports2, module2) {
    "use strict";
    var isObject = require_is_extendable();
    module2.exports = function extend(o) {
      if (!isObject(o)) {
        o = {};
      }
      var len = arguments.length;
      for (var i = 1; i < len; i++) {
        var obj = arguments[i];
        if (isObject(obj)) {
          assign(o, obj);
        }
      }
      return o;
    };
    function assign(a, b) {
      for (var key in b) {
        if (hasOwn(b, key)) {
          a[key] = b[key];
        }
      }
    }
    function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    }
  }
});

// node_modules/section-matter/index.js
var require_section_matter = __commonJS({
  "node_modules/section-matter/index.js"(exports2, module2) {
    "use strict";
    var typeOf = require_kind_of();
    var extend = require_extend_shallow();
    module2.exports = function(input, options2) {
      if (typeof options2 === "function") {
        options2 = { parse: options2 };
      }
      var file = toObject(input);
      var defaults = { section_delimiter: "---", parse: identity };
      var opts = extend({}, defaults, options2);
      var delim = opts.section_delimiter;
      var lines = file.content.split(/\r?\n/);
      var sections = null;
      var section = createSection();
      var content = [];
      var stack = [];
      function initSections(val) {
        file.content = val;
        sections = [];
        content = [];
      }
      function closeSection(val) {
        if (stack.length) {
          section.key = getKey(stack[0], delim);
          section.content = val;
          opts.parse(section, sections);
          sections.push(section);
          section = createSection();
          content = [];
          stack = [];
        }
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var len = stack.length;
        var ln = line.trim();
        if (isDelimiter(ln, delim)) {
          if (ln.length === 3 && i !== 0) {
            if (len === 0 || len === 2) {
              content.push(line);
              continue;
            }
            stack.push(ln);
            section.data = content.join("\n");
            content = [];
            continue;
          }
          if (sections === null) {
            initSections(content.join("\n"));
          }
          if (len === 2) {
            closeSection(content.join("\n"));
          }
          stack.push(ln);
          continue;
        }
        content.push(line);
      }
      if (sections === null) {
        initSections(content.join("\n"));
      } else {
        closeSection(content.join("\n"));
      }
      file.sections = sections;
      return file;
    };
    function isDelimiter(line, delim) {
      if (line.slice(0, delim.length) !== delim) {
        return false;
      }
      if (line.charAt(delim.length + 1) === delim.slice(-1)) {
        return false;
      }
      return true;
    }
    function toObject(input) {
      if (typeOf(input) !== "object") {
        input = { content: input };
      }
      if (typeof input.content !== "string" && !isBuffer(input.content)) {
        throw new TypeError("expected a buffer or string");
      }
      input.content = input.content.toString();
      input.sections = [];
      return input;
    }
    function getKey(val, delim) {
      return val ? val.slice(delim.length).trim() : "";
    }
    function createSection() {
      return { key: "", data: "", content: "" };
    }
    function identity(val) {
      return val;
    }
    function isBuffer(val) {
      if (val && val.constructor && typeof val.constructor.isBuffer === "function") {
        return val.constructor.isBuffer(val);
      }
      return false;
    }
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/common.js
var require_common = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/common.js"(exports2, module2) {
    "use strict";
    function isNothing(subject) {
      return typeof subject === "undefined" || subject === null;
    }
    function isObject(subject) {
      return typeof subject === "object" && subject !== null;
    }
    function toArray(sequence) {
      if (Array.isArray(sequence)) return sequence;
      else if (isNothing(sequence)) return [];
      return [sequence];
    }
    function extend(target, source) {
      var index, length, key, sourceKeys;
      if (source) {
        sourceKeys = Object.keys(source);
        for (index = 0, length = sourceKeys.length; index < length; index += 1) {
          key = sourceKeys[index];
          target[key] = source[key];
        }
      }
      return target;
    }
    function repeat(string, count) {
      var result2 = "", cycle;
      for (cycle = 0; cycle < count; cycle += 1) {
        result2 += string;
      }
      return result2;
    }
    function isNegativeZero(number) {
      return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
    }
    module2.exports.isNothing = isNothing;
    module2.exports.isObject = isObject;
    module2.exports.toArray = toArray;
    module2.exports.repeat = repeat;
    module2.exports.isNegativeZero = isNegativeZero;
    module2.exports.extend = extend;
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/exception.js
var require_exception = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/exception.js"(exports2, module2) {
    "use strict";
    function YAMLException(reason, mark) {
      Error.call(this);
      this.name = "YAMLException";
      this.reason = reason;
      this.mark = mark;
      this.message = (this.reason || "(unknown reason)") + (this.mark ? " " + this.mark.toString() : "");
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
      } else {
        this.stack = new Error().stack || "";
      }
    }
    YAMLException.prototype = Object.create(Error.prototype);
    YAMLException.prototype.constructor = YAMLException;
    YAMLException.prototype.toString = function toString(compact) {
      var result2 = this.name + ": ";
      result2 += this.reason || "(unknown reason)";
      if (!compact && this.mark) {
        result2 += " " + this.mark.toString();
      }
      return result2;
    };
    module2.exports = YAMLException;
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/mark.js
var require_mark = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/mark.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    function Mark(name, buffer, position, line, column) {
      this.name = name;
      this.buffer = buffer;
      this.position = position;
      this.line = line;
      this.column = column;
    }
    Mark.prototype.getSnippet = function getSnippet(indent, maxLength) {
      var head, start, tail, end, snippet;
      if (!this.buffer) return null;
      indent = indent || 4;
      maxLength = maxLength || 75;
      head = "";
      start = this.position;
      while (start > 0 && "\0\r\n\x85\u2028\u2029".indexOf(this.buffer.charAt(start - 1)) === -1) {
        start -= 1;
        if (this.position - start > maxLength / 2 - 1) {
          head = " ... ";
          start += 5;
          break;
        }
      }
      tail = "";
      end = this.position;
      while (end < this.buffer.length && "\0\r\n\x85\u2028\u2029".indexOf(this.buffer.charAt(end)) === -1) {
        end += 1;
        if (end - this.position > maxLength / 2 - 1) {
          tail = " ... ";
          end -= 5;
          break;
        }
      }
      snippet = this.buffer.slice(start, end);
      return common.repeat(" ", indent) + head + snippet + tail + "\n" + common.repeat(" ", indent + this.position - start + head.length) + "^";
    };
    Mark.prototype.toString = function toString(compact) {
      var snippet, where = "";
      if (this.name) {
        where += 'in "' + this.name + '" ';
      }
      where += "at line " + (this.line + 1) + ", column " + (this.column + 1);
      if (!compact) {
        snippet = this.getSnippet();
        if (snippet) {
          where += ":\n" + snippet;
        }
      }
      return where;
    };
    module2.exports = Mark;
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type.js
var require_type = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type.js"(exports2, module2) {
    "use strict";
    var YAMLException = require_exception();
    var TYPE_CONSTRUCTOR_OPTIONS = [
      "kind",
      "resolve",
      "construct",
      "instanceOf",
      "predicate",
      "represent",
      "defaultStyle",
      "styleAliases"
    ];
    var YAML_NODE_KINDS = [
      "scalar",
      "sequence",
      "mapping"
    ];
    function compileStyleAliases(map) {
      var result2 = {};
      if (map !== null) {
        Object.keys(map).forEach(function(style) {
          map[style].forEach(function(alias) {
            result2[String(alias)] = style;
          });
        });
      }
      return result2;
    }
    function Type(tag, options2) {
      options2 = options2 || {};
      Object.keys(options2).forEach(function(name) {
        if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) {
          throw new YAMLException('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.');
        }
      });
      this.tag = tag;
      this.kind = options2["kind"] || null;
      this.resolve = options2["resolve"] || function() {
        return true;
      };
      this.construct = options2["construct"] || function(data) {
        return data;
      };
      this.instanceOf = options2["instanceOf"] || null;
      this.predicate = options2["predicate"] || null;
      this.represent = options2["represent"] || null;
      this.defaultStyle = options2["defaultStyle"] || null;
      this.styleAliases = compileStyleAliases(options2["styleAliases"] || null);
      if (YAML_NODE_KINDS.indexOf(this.kind) === -1) {
        throw new YAMLException('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.');
      }
    }
    module2.exports = Type;
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema.js
var require_schema = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var YAMLException = require_exception();
    var Type = require_type();
    function compileList(schema, name, result2) {
      var exclude = [];
      schema.include.forEach(function(includedSchema) {
        result2 = compileList(includedSchema, name, result2);
      });
      schema[name].forEach(function(currentType) {
        result2.forEach(function(previousType, previousIndex) {
          if (previousType.tag === currentType.tag && previousType.kind === currentType.kind) {
            exclude.push(previousIndex);
          }
        });
        result2.push(currentType);
      });
      return result2.filter(function(type, index) {
        return exclude.indexOf(index) === -1;
      });
    }
    function compileMap() {
      var result2 = {
        scalar: {},
        sequence: {},
        mapping: {},
        fallback: {}
      }, index, length;
      function collectType(type) {
        result2[type.kind][type.tag] = result2["fallback"][type.tag] = type;
      }
      for (index = 0, length = arguments.length; index < length; index += 1) {
        arguments[index].forEach(collectType);
      }
      return result2;
    }
    function Schema(definition) {
      this.include = definition.include || [];
      this.implicit = definition.implicit || [];
      this.explicit = definition.explicit || [];
      this.implicit.forEach(function(type) {
        if (type.loadKind && type.loadKind !== "scalar") {
          throw new YAMLException("There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.");
        }
      });
      this.compiledImplicit = compileList(this, "implicit", []);
      this.compiledExplicit = compileList(this, "explicit", []);
      this.compiledTypeMap = compileMap(this.compiledImplicit, this.compiledExplicit);
    }
    Schema.DEFAULT = null;
    Schema.create = function createSchema() {
      var schemas, types;
      switch (arguments.length) {
        case 1:
          schemas = Schema.DEFAULT;
          types = arguments[0];
          break;
        case 2:
          schemas = arguments[0];
          types = arguments[1];
          break;
        default:
          throw new YAMLException("Wrong number of arguments for Schema.create function");
      }
      schemas = common.toArray(schemas);
      types = common.toArray(types);
      if (!schemas.every(function(schema) {
        return schema instanceof Schema;
      })) {
        throw new YAMLException("Specified list of super schemas (or a single Schema object) contains a non-Schema object.");
      }
      if (!types.every(function(type) {
        return type instanceof Type;
      })) {
        throw new YAMLException("Specified list of YAML types (or a single Type object) contains a non-Type object.");
      }
      return new Schema({
        include: schemas,
        explicit: types
      });
    };
    module2.exports = Schema;
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/str.js
var require_str = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/str.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    module2.exports = new Type("tag:yaml.org,2002:str", {
      kind: "scalar",
      construct: function(data) {
        return data !== null ? data : "";
      }
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/seq.js
var require_seq = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/seq.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    module2.exports = new Type("tag:yaml.org,2002:seq", {
      kind: "sequence",
      construct: function(data) {
        return data !== null ? data : [];
      }
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/map.js
var require_map = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/map.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    module2.exports = new Type("tag:yaml.org,2002:map", {
      kind: "mapping",
      construct: function(data) {
        return data !== null ? data : {};
      }
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/failsafe.js
var require_failsafe = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/failsafe.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      explicit: [
        require_str(),
        require_seq(),
        require_map()
      ]
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/null.js
var require_null = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/null.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveYamlNull(data) {
      if (data === null) return true;
      var max = data.length;
      return max === 1 && data === "~" || max === 4 && (data === "null" || data === "Null" || data === "NULL");
    }
    function constructYamlNull() {
      return null;
    }
    function isNull(object) {
      return object === null;
    }
    module2.exports = new Type("tag:yaml.org,2002:null", {
      kind: "scalar",
      resolve: resolveYamlNull,
      construct: constructYamlNull,
      predicate: isNull,
      represent: {
        canonical: function() {
          return "~";
        },
        lowercase: function() {
          return "null";
        },
        uppercase: function() {
          return "NULL";
        },
        camelcase: function() {
          return "Null";
        }
      },
      defaultStyle: "lowercase"
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/bool.js
var require_bool = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/bool.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveYamlBoolean(data) {
      if (data === null) return false;
      var max = data.length;
      return max === 4 && (data === "true" || data === "True" || data === "TRUE") || max === 5 && (data === "false" || data === "False" || data === "FALSE");
    }
    function constructYamlBoolean(data) {
      return data === "true" || data === "True" || data === "TRUE";
    }
    function isBoolean(object) {
      return Object.prototype.toString.call(object) === "[object Boolean]";
    }
    module2.exports = new Type("tag:yaml.org,2002:bool", {
      kind: "scalar",
      resolve: resolveYamlBoolean,
      construct: constructYamlBoolean,
      predicate: isBoolean,
      represent: {
        lowercase: function(object) {
          return object ? "true" : "false";
        },
        uppercase: function(object) {
          return object ? "TRUE" : "FALSE";
        },
        camelcase: function(object) {
          return object ? "True" : "False";
        }
      },
      defaultStyle: "lowercase"
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/int.js
var require_int = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/int.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var Type = require_type();
    function isHexCode(c) {
      return 48 <= c && c <= 57 || 65 <= c && c <= 70 || 97 <= c && c <= 102;
    }
    function isOctCode(c) {
      return 48 <= c && c <= 55;
    }
    function isDecCode(c) {
      return 48 <= c && c <= 57;
    }
    function resolveYamlInteger(data) {
      if (data === null) return false;
      var max = data.length, index = 0, hasDigits = false, ch;
      if (!max) return false;
      ch = data[index];
      if (ch === "-" || ch === "+") {
        ch = data[++index];
      }
      if (ch === "0") {
        if (index + 1 === max) return true;
        ch = data[++index];
        if (ch === "b") {
          index++;
          for (; index < max; index++) {
            ch = data[index];
            if (ch === "_") continue;
            if (ch !== "0" && ch !== "1") return false;
            hasDigits = true;
          }
          return hasDigits && ch !== "_";
        }
        if (ch === "x") {
          index++;
          for (; index < max; index++) {
            ch = data[index];
            if (ch === "_") continue;
            if (!isHexCode(data.charCodeAt(index))) return false;
            hasDigits = true;
          }
          return hasDigits && ch !== "_";
        }
        for (; index < max; index++) {
          ch = data[index];
          if (ch === "_") continue;
          if (!isOctCode(data.charCodeAt(index))) return false;
          hasDigits = true;
        }
        return hasDigits && ch !== "_";
      }
      if (ch === "_") return false;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (ch === ":") break;
        if (!isDecCode(data.charCodeAt(index))) {
          return false;
        }
        hasDigits = true;
      }
      if (!hasDigits || ch === "_") return false;
      if (ch !== ":") return true;
      return /^(:[0-5]?[0-9])+$/.test(data.slice(index));
    }
    function constructYamlInteger(data) {
      var value = data, sign = 1, ch, base, digits = [];
      if (value.indexOf("_") !== -1) {
        value = value.replace(/_/g, "");
      }
      ch = value[0];
      if (ch === "-" || ch === "+") {
        if (ch === "-") sign = -1;
        value = value.slice(1);
        ch = value[0];
      }
      if (value === "0") return 0;
      if (ch === "0") {
        if (value[1] === "b") return sign * parseInt(value.slice(2), 2);
        if (value[1] === "x") return sign * parseInt(value, 16);
        return sign * parseInt(value, 8);
      }
      if (value.indexOf(":") !== -1) {
        value.split(":").forEach(function(v) {
          digits.unshift(parseInt(v, 10));
        });
        value = 0;
        base = 1;
        digits.forEach(function(d) {
          value += d * base;
          base *= 60;
        });
        return sign * value;
      }
      return sign * parseInt(value, 10);
    }
    function isInteger(object) {
      return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 === 0 && !common.isNegativeZero(object));
    }
    module2.exports = new Type("tag:yaml.org,2002:int", {
      kind: "scalar",
      resolve: resolveYamlInteger,
      construct: constructYamlInteger,
      predicate: isInteger,
      represent: {
        binary: function(obj) {
          return obj >= 0 ? "0b" + obj.toString(2) : "-0b" + obj.toString(2).slice(1);
        },
        octal: function(obj) {
          return obj >= 0 ? "0" + obj.toString(8) : "-0" + obj.toString(8).slice(1);
        },
        decimal: function(obj) {
          return obj.toString(10);
        },
        /* eslint-disable max-len */
        hexadecimal: function(obj) {
          return obj >= 0 ? "0x" + obj.toString(16).toUpperCase() : "-0x" + obj.toString(16).toUpperCase().slice(1);
        }
      },
      defaultStyle: "decimal",
      styleAliases: {
        binary: [2, "bin"],
        octal: [8, "oct"],
        decimal: [10, "dec"],
        hexadecimal: [16, "hex"]
      }
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/float.js
var require_float = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/float.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var Type = require_type();
    var YAML_FLOAT_PATTERN = new RegExp(
      // 2.5e4, 2.5 and integers
      "^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
    );
    function resolveYamlFloat(data) {
      if (data === null) return false;
      if (!YAML_FLOAT_PATTERN.test(data) || // Quick hack to not allow integers end with `_`
      // Probably should update regexp & check speed
      data[data.length - 1] === "_") {
        return false;
      }
      return true;
    }
    function constructYamlFloat(data) {
      var value, sign, base, digits;
      value = data.replace(/_/g, "").toLowerCase();
      sign = value[0] === "-" ? -1 : 1;
      digits = [];
      if ("+-".indexOf(value[0]) >= 0) {
        value = value.slice(1);
      }
      if (value === ".inf") {
        return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      } else if (value === ".nan") {
        return NaN;
      } else if (value.indexOf(":") >= 0) {
        value.split(":").forEach(function(v) {
          digits.unshift(parseFloat(v, 10));
        });
        value = 0;
        base = 1;
        digits.forEach(function(d) {
          value += d * base;
          base *= 60;
        });
        return sign * value;
      }
      return sign * parseFloat(value, 10);
    }
    var SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
    function representYamlFloat(object, style) {
      var res;
      if (isNaN(object)) {
        switch (style) {
          case "lowercase":
            return ".nan";
          case "uppercase":
            return ".NAN";
          case "camelcase":
            return ".NaN";
        }
      } else if (Number.POSITIVE_INFINITY === object) {
        switch (style) {
          case "lowercase":
            return ".inf";
          case "uppercase":
            return ".INF";
          case "camelcase":
            return ".Inf";
        }
      } else if (Number.NEGATIVE_INFINITY === object) {
        switch (style) {
          case "lowercase":
            return "-.inf";
          case "uppercase":
            return "-.INF";
          case "camelcase":
            return "-.Inf";
        }
      } else if (common.isNegativeZero(object)) {
        return "-0.0";
      }
      res = object.toString(10);
      return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
    }
    function isFloat(object) {
      return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 !== 0 || common.isNegativeZero(object));
    }
    module2.exports = new Type("tag:yaml.org,2002:float", {
      kind: "scalar",
      resolve: resolveYamlFloat,
      construct: constructYamlFloat,
      predicate: isFloat,
      represent: representYamlFloat,
      defaultStyle: "lowercase"
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/json.js
var require_json = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/json.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      include: [
        require_failsafe()
      ],
      implicit: [
        require_null(),
        require_bool(),
        require_int(),
        require_float()
      ]
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/core.js
var require_core = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/core.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      include: [
        require_json()
      ]
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/timestamp.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var YAML_DATE_REGEXP = new RegExp(
      "^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$"
    );
    var YAML_TIMESTAMP_REGEXP = new RegExp(
      "^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$"
    );
    function resolveYamlTimestamp(data) {
      if (data === null) return false;
      if (YAML_DATE_REGEXP.exec(data) !== null) return true;
      if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
      return false;
    }
    function constructYamlTimestamp(data) {
      var match, year, month, day, hour, minute, second, fraction = 0, delta = null, tz_hour, tz_minute, date;
      match = YAML_DATE_REGEXP.exec(data);
      if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);
      if (match === null) throw new Error("Date resolve error");
      year = +match[1];
      month = +match[2] - 1;
      day = +match[3];
      if (!match[4]) {
        return new Date(Date.UTC(year, month, day));
      }
      hour = +match[4];
      minute = +match[5];
      second = +match[6];
      if (match[7]) {
        fraction = match[7].slice(0, 3);
        while (fraction.length < 3) {
          fraction += "0";
        }
        fraction = +fraction;
      }
      if (match[9]) {
        tz_hour = +match[10];
        tz_minute = +(match[11] || 0);
        delta = (tz_hour * 60 + tz_minute) * 6e4;
        if (match[9] === "-") delta = -delta;
      }
      date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
      if (delta) date.setTime(date.getTime() - delta);
      return date;
    }
    function representYamlTimestamp(object) {
      return object.toISOString();
    }
    module2.exports = new Type("tag:yaml.org,2002:timestamp", {
      kind: "scalar",
      resolve: resolveYamlTimestamp,
      construct: constructYamlTimestamp,
      instanceOf: Date,
      represent: representYamlTimestamp
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/merge.js
var require_merge = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/merge.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveYamlMerge(data) {
      return data === "<<" || data === null;
    }
    module2.exports = new Type("tag:yaml.org,2002:merge", {
      kind: "scalar",
      resolve: resolveYamlMerge
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/binary.js
var require_binary = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/binary.js"(exports2, module2) {
    "use strict";
    var NodeBuffer;
    try {
      _require = require;
      NodeBuffer = _require("buffer").Buffer;
    } catch (__) {
    }
    var _require;
    var Type = require_type();
    var BASE64_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r";
    function resolveYamlBinary(data) {
      if (data === null) return false;
      var code, idx, bitlen = 0, max = data.length, map = BASE64_MAP;
      for (idx = 0; idx < max; idx++) {
        code = map.indexOf(data.charAt(idx));
        if (code > 64) continue;
        if (code < 0) return false;
        bitlen += 6;
      }
      return bitlen % 8 === 0;
    }
    function constructYamlBinary(data) {
      var idx, tailbits, input = data.replace(/[\r\n=]/g, ""), max = input.length, map = BASE64_MAP, bits = 0, result2 = [];
      for (idx = 0; idx < max; idx++) {
        if (idx % 4 === 0 && idx) {
          result2.push(bits >> 16 & 255);
          result2.push(bits >> 8 & 255);
          result2.push(bits & 255);
        }
        bits = bits << 6 | map.indexOf(input.charAt(idx));
      }
      tailbits = max % 4 * 6;
      if (tailbits === 0) {
        result2.push(bits >> 16 & 255);
        result2.push(bits >> 8 & 255);
        result2.push(bits & 255);
      } else if (tailbits === 18) {
        result2.push(bits >> 10 & 255);
        result2.push(bits >> 2 & 255);
      } else if (tailbits === 12) {
        result2.push(bits >> 4 & 255);
      }
      if (NodeBuffer) {
        return NodeBuffer.from ? NodeBuffer.from(result2) : new NodeBuffer(result2);
      }
      return result2;
    }
    function representYamlBinary(object) {
      var result2 = "", bits = 0, idx, tail, max = object.length, map = BASE64_MAP;
      for (idx = 0; idx < max; idx++) {
        if (idx % 3 === 0 && idx) {
          result2 += map[bits >> 18 & 63];
          result2 += map[bits >> 12 & 63];
          result2 += map[bits >> 6 & 63];
          result2 += map[bits & 63];
        }
        bits = (bits << 8) + object[idx];
      }
      tail = max % 3;
      if (tail === 0) {
        result2 += map[bits >> 18 & 63];
        result2 += map[bits >> 12 & 63];
        result2 += map[bits >> 6 & 63];
        result2 += map[bits & 63];
      } else if (tail === 2) {
        result2 += map[bits >> 10 & 63];
        result2 += map[bits >> 4 & 63];
        result2 += map[bits << 2 & 63];
        result2 += map[64];
      } else if (tail === 1) {
        result2 += map[bits >> 2 & 63];
        result2 += map[bits << 4 & 63];
        result2 += map[64];
        result2 += map[64];
      }
      return result2;
    }
    function isBinary(object) {
      return NodeBuffer && NodeBuffer.isBuffer(object);
    }
    module2.exports = new Type("tag:yaml.org,2002:binary", {
      kind: "scalar",
      resolve: resolveYamlBinary,
      construct: constructYamlBinary,
      predicate: isBinary,
      represent: representYamlBinary
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/omap.js
var require_omap = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/omap.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    var _toString = Object.prototype.toString;
    function resolveYamlOmap(data) {
      if (data === null) return true;
      var objectKeys = [], index, length, pair, pairKey, pairHasKey, object = data;
      for (index = 0, length = object.length; index < length; index += 1) {
        pair = object[index];
        pairHasKey = false;
        if (_toString.call(pair) !== "[object Object]") return false;
        for (pairKey in pair) {
          if (_hasOwnProperty.call(pair, pairKey)) {
            if (!pairHasKey) pairHasKey = true;
            else return false;
          }
        }
        if (!pairHasKey) return false;
        if (objectKeys.indexOf(pairKey) === -1) objectKeys.push(pairKey);
        else return false;
      }
      return true;
    }
    function constructYamlOmap(data) {
      return data !== null ? data : [];
    }
    module2.exports = new Type("tag:yaml.org,2002:omap", {
      kind: "sequence",
      resolve: resolveYamlOmap,
      construct: constructYamlOmap
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/pairs.js
var require_pairs = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/pairs.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _toString = Object.prototype.toString;
    function resolveYamlPairs(data) {
      if (data === null) return true;
      var index, length, pair, keys, result2, object = data;
      result2 = new Array(object.length);
      for (index = 0, length = object.length; index < length; index += 1) {
        pair = object[index];
        if (_toString.call(pair) !== "[object Object]") return false;
        keys = Object.keys(pair);
        if (keys.length !== 1) return false;
        result2[index] = [keys[0], pair[keys[0]]];
      }
      return true;
    }
    function constructYamlPairs(data) {
      if (data === null) return [];
      var index, length, pair, keys, result2, object = data;
      result2 = new Array(object.length);
      for (index = 0, length = object.length; index < length; index += 1) {
        pair = object[index];
        keys = Object.keys(pair);
        result2[index] = [keys[0], pair[keys[0]]];
      }
      return result2;
    }
    module2.exports = new Type("tag:yaml.org,2002:pairs", {
      kind: "sequence",
      resolve: resolveYamlPairs,
      construct: constructYamlPairs
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/set.js
var require_set = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/set.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    function resolveYamlSet(data) {
      if (data === null) return true;
      var key, object = data;
      for (key in object) {
        if (_hasOwnProperty.call(object, key)) {
          if (object[key] !== null) return false;
        }
      }
      return true;
    }
    function constructYamlSet(data) {
      return data !== null ? data : {};
    }
    module2.exports = new Type("tag:yaml.org,2002:set", {
      kind: "mapping",
      resolve: resolveYamlSet,
      construct: constructYamlSet
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/default_safe.js
var require_default_safe = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/default_safe.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      include: [
        require_core()
      ],
      implicit: [
        require_timestamp(),
        require_merge()
      ],
      explicit: [
        require_binary(),
        require_omap(),
        require_pairs(),
        require_set()
      ]
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/js/undefined.js
var require_undefined = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/js/undefined.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveJavascriptUndefined() {
      return true;
    }
    function constructJavascriptUndefined() {
      return void 0;
    }
    function representJavascriptUndefined() {
      return "";
    }
    function isUndefined(object) {
      return typeof object === "undefined";
    }
    module2.exports = new Type("tag:yaml.org,2002:js/undefined", {
      kind: "scalar",
      resolve: resolveJavascriptUndefined,
      construct: constructJavascriptUndefined,
      predicate: isUndefined,
      represent: representJavascriptUndefined
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/js/regexp.js
var require_regexp = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/js/regexp.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveJavascriptRegExp(data) {
      if (data === null) return false;
      if (data.length === 0) return false;
      var regexp = data, tail = /\/([gim]*)$/.exec(data), modifiers = "";
      if (regexp[0] === "/") {
        if (tail) modifiers = tail[1];
        if (modifiers.length > 3) return false;
        if (regexp[regexp.length - modifiers.length - 1] !== "/") return false;
      }
      return true;
    }
    function constructJavascriptRegExp(data) {
      var regexp = data, tail = /\/([gim]*)$/.exec(data), modifiers = "";
      if (regexp[0] === "/") {
        if (tail) modifiers = tail[1];
        regexp = regexp.slice(1, regexp.length - modifiers.length - 1);
      }
      return new RegExp(regexp, modifiers);
    }
    function representJavascriptRegExp(object) {
      var result2 = "/" + object.source + "/";
      if (object.global) result2 += "g";
      if (object.multiline) result2 += "m";
      if (object.ignoreCase) result2 += "i";
      return result2;
    }
    function isRegExp(object) {
      return Object.prototype.toString.call(object) === "[object RegExp]";
    }
    module2.exports = new Type("tag:yaml.org,2002:js/regexp", {
      kind: "scalar",
      resolve: resolveJavascriptRegExp,
      construct: constructJavascriptRegExp,
      predicate: isRegExp,
      represent: representJavascriptRegExp
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/js/function.js
var require_function = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/type/js/function.js"(exports2, module2) {
    "use strict";
    var esprima;
    try {
      _require = require;
      esprima = _require("esprima");
    } catch (_) {
      if (typeof window !== "undefined") esprima = window.esprima;
    }
    var _require;
    var Type = require_type();
    function resolveJavascriptFunction(data) {
      if (data === null) return false;
      try {
        var source = "(" + data + ")", ast = esprima.parse(source, { range: true });
        if (ast.type !== "Program" || ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement" || ast.body[0].expression.type !== "ArrowFunctionExpression" && ast.body[0].expression.type !== "FunctionExpression") {
          return false;
        }
        return true;
      } catch (err) {
        return false;
      }
    }
    function constructJavascriptFunction(data) {
      var source = "(" + data + ")", ast = esprima.parse(source, { range: true }), params = [], body;
      if (ast.type !== "Program" || ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement" || ast.body[0].expression.type !== "ArrowFunctionExpression" && ast.body[0].expression.type !== "FunctionExpression") {
        throw new Error("Failed to resolve function");
      }
      ast.body[0].expression.params.forEach(function(param) {
        params.push(param.name);
      });
      body = ast.body[0].expression.body.range;
      if (ast.body[0].expression.body.type === "BlockStatement") {
        return new Function(params, source.slice(body[0] + 1, body[1] - 1));
      }
      return new Function(params, "return " + source.slice(body[0], body[1]));
    }
    function representJavascriptFunction(object) {
      return object.toString();
    }
    function isFunction(object) {
      return Object.prototype.toString.call(object) === "[object Function]";
    }
    module2.exports = new Type("tag:yaml.org,2002:js/function", {
      kind: "scalar",
      resolve: resolveJavascriptFunction,
      construct: constructJavascriptFunction,
      predicate: isFunction,
      represent: representJavascriptFunction
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/default_full.js
var require_default_full = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/schema/default_full.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = Schema.DEFAULT = new Schema({
      include: [
        require_default_safe()
      ],
      explicit: [
        require_undefined(),
        require_regexp(),
        require_function()
      ]
    });
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/loader.js
var require_loader = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/loader.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var YAMLException = require_exception();
    var Mark = require_mark();
    var DEFAULT_SAFE_SCHEMA = require_default_safe();
    var DEFAULT_FULL_SCHEMA = require_default_full();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    var CONTEXT_FLOW_IN = 1;
    var CONTEXT_FLOW_OUT = 2;
    var CONTEXT_BLOCK_IN = 3;
    var CONTEXT_BLOCK_OUT = 4;
    var CHOMPING_CLIP = 1;
    var CHOMPING_STRIP = 2;
    var CHOMPING_KEEP = 3;
    var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
    var PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
    var PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
    var PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
    var PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
    function _class(obj) {
      return Object.prototype.toString.call(obj);
    }
    function is_EOL(c) {
      return c === 10 || c === 13;
    }
    function is_WHITE_SPACE(c) {
      return c === 9 || c === 32;
    }
    function is_WS_OR_EOL(c) {
      return c === 9 || c === 32 || c === 10 || c === 13;
    }
    function is_FLOW_INDICATOR(c) {
      return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
    }
    function fromHexCode(c) {
      var lc;
      if (48 <= c && c <= 57) {
        return c - 48;
      }
      lc = c | 32;
      if (97 <= lc && lc <= 102) {
        return lc - 97 + 10;
      }
      return -1;
    }
    function escapedHexLen(c) {
      if (c === 120) {
        return 2;
      }
      if (c === 117) {
        return 4;
      }
      if (c === 85) {
        return 8;
      }
      return 0;
    }
    function fromDecimalCode(c) {
      if (48 <= c && c <= 57) {
        return c - 48;
      }
      return -1;
    }
    function simpleEscapeSequence(c) {
      return c === 48 ? "\0" : c === 97 ? "\x07" : c === 98 ? "\b" : c === 116 ? "	" : c === 9 ? "	" : c === 110 ? "\n" : c === 118 ? "\v" : c === 102 ? "\f" : c === 114 ? "\r" : c === 101 ? "\x1B" : c === 32 ? " " : c === 34 ? '"' : c === 47 ? "/" : c === 92 ? "\\" : c === 78 ? "\x85" : c === 95 ? "\xA0" : c === 76 ? "\u2028" : c === 80 ? "\u2029" : "";
    }
    function charFromCodepoint(c) {
      if (c <= 65535) {
        return String.fromCharCode(c);
      }
      return String.fromCharCode(
        (c - 65536 >> 10) + 55296,
        (c - 65536 & 1023) + 56320
      );
    }
    function setProperty(object, key, value) {
      if (key === "__proto__") {
        Object.defineProperty(object, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        });
      } else {
        object[key] = value;
      }
    }
    var simpleEscapeCheck = new Array(256);
    var simpleEscapeMap = new Array(256);
    for (i = 0; i < 256; i++) {
      simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
      simpleEscapeMap[i] = simpleEscapeSequence(i);
    }
    var i;
    function State(input, options2) {
      this.input = input;
      this.filename = options2["filename"] || null;
      this.schema = options2["schema"] || DEFAULT_FULL_SCHEMA;
      this.onWarning = options2["onWarning"] || null;
      this.legacy = options2["legacy"] || false;
      this.json = options2["json"] || false;
      this.listener = options2["listener"] || null;
      this.implicitTypes = this.schema.compiledImplicit;
      this.typeMap = this.schema.compiledTypeMap;
      this.length = input.length;
      this.position = 0;
      this.line = 0;
      this.lineStart = 0;
      this.lineIndent = 0;
      this.documents = [];
    }
    function generateError(state, message) {
      return new YAMLException(
        message,
        new Mark(state.filename, state.input, state.position, state.line, state.position - state.lineStart)
      );
    }
    function throwError(state, message) {
      throw generateError(state, message);
    }
    function throwWarning(state, message) {
      if (state.onWarning) {
        state.onWarning.call(null, generateError(state, message));
      }
    }
    var directiveHandlers = {
      YAML: function handleYamlDirective(state, name, args) {
        var match, major, minor;
        if (state.version !== null) {
          throwError(state, "duplication of %YAML directive");
        }
        if (args.length !== 1) {
          throwError(state, "YAML directive accepts exactly one argument");
        }
        match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
        if (match === null) {
          throwError(state, "ill-formed argument of the YAML directive");
        }
        major = parseInt(match[1], 10);
        minor = parseInt(match[2], 10);
        if (major !== 1) {
          throwError(state, "unacceptable YAML version of the document");
        }
        state.version = args[0];
        state.checkLineBreaks = minor < 2;
        if (minor !== 1 && minor !== 2) {
          throwWarning(state, "unsupported YAML version of the document");
        }
      },
      TAG: function handleTagDirective(state, name, args) {
        var handle, prefix;
        if (args.length !== 2) {
          throwError(state, "TAG directive accepts exactly two arguments");
        }
        handle = args[0];
        prefix = args[1];
        if (!PATTERN_TAG_HANDLE.test(handle)) {
          throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
        }
        if (_hasOwnProperty.call(state.tagMap, handle)) {
          throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
        }
        if (!PATTERN_TAG_URI.test(prefix)) {
          throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
        }
        state.tagMap[handle] = prefix;
      }
    };
    function captureSegment(state, start, end, checkJson) {
      var _position, _length, _character, _result;
      if (start < end) {
        _result = state.input.slice(start, end);
        if (checkJson) {
          for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
            _character = _result.charCodeAt(_position);
            if (!(_character === 9 || 32 <= _character && _character <= 1114111)) {
              throwError(state, "expected valid JSON character");
            }
          }
        } else if (PATTERN_NON_PRINTABLE.test(_result)) {
          throwError(state, "the stream contains non-printable characters");
        }
        state.result += _result;
      }
    }
    function mergeMappings(state, destination, source, overridableKeys) {
      var sourceKeys, key, index, quantity;
      if (!common.isObject(source)) {
        throwError(state, "cannot merge mappings; the provided source object is unacceptable");
      }
      sourceKeys = Object.keys(source);
      for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
        key = sourceKeys[index];
        if (!_hasOwnProperty.call(destination, key)) {
          setProperty(destination, key, source[key]);
          overridableKeys[key] = true;
        }
      }
    }
    function storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startPos) {
      var index, quantity;
      if (Array.isArray(keyNode)) {
        keyNode = Array.prototype.slice.call(keyNode);
        for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
          if (Array.isArray(keyNode[index])) {
            throwError(state, "nested arrays are not supported inside keys");
          }
          if (typeof keyNode === "object" && _class(keyNode[index]) === "[object Object]") {
            keyNode[index] = "[object Object]";
          }
        }
      }
      if (typeof keyNode === "object" && _class(keyNode) === "[object Object]") {
        keyNode = "[object Object]";
      }
      keyNode = String(keyNode);
      if (_result === null) {
        _result = {};
      }
      if (keyTag === "tag:yaml.org,2002:merge") {
        if (Array.isArray(valueNode)) {
          for (index = 0, quantity = valueNode.length; index < quantity; index += 1) {
            mergeMappings(state, _result, valueNode[index], overridableKeys);
          }
        } else {
          mergeMappings(state, _result, valueNode, overridableKeys);
        }
      } else {
        if (!state.json && !_hasOwnProperty.call(overridableKeys, keyNode) && _hasOwnProperty.call(_result, keyNode)) {
          state.line = startLine || state.line;
          state.position = startPos || state.position;
          throwError(state, "duplicated mapping key");
        }
        setProperty(_result, keyNode, valueNode);
        delete overridableKeys[keyNode];
      }
      return _result;
    }
    function readLineBreak(state) {
      var ch;
      ch = state.input.charCodeAt(state.position);
      if (ch === 10) {
        state.position++;
      } else if (ch === 13) {
        state.position++;
        if (state.input.charCodeAt(state.position) === 10) {
          state.position++;
        }
      } else {
        throwError(state, "a line break is expected");
      }
      state.line += 1;
      state.lineStart = state.position;
    }
    function skipSeparationSpace(state, allowComments, checkIndent) {
      var lineBreaks = 0, ch = state.input.charCodeAt(state.position);
      while (ch !== 0) {
        while (is_WHITE_SPACE(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        if (allowComments && ch === 35) {
          do {
            ch = state.input.charCodeAt(++state.position);
          } while (ch !== 10 && ch !== 13 && ch !== 0);
        }
        if (is_EOL(ch)) {
          readLineBreak(state);
          ch = state.input.charCodeAt(state.position);
          lineBreaks++;
          state.lineIndent = 0;
          while (ch === 32) {
            state.lineIndent++;
            ch = state.input.charCodeAt(++state.position);
          }
        } else {
          break;
        }
      }
      if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) {
        throwWarning(state, "deficient indentation");
      }
      return lineBreaks;
    }
    function testDocumentSeparator(state) {
      var _position = state.position, ch;
      ch = state.input.charCodeAt(_position);
      if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(_position + 1) && ch === state.input.charCodeAt(_position + 2)) {
        _position += 3;
        ch = state.input.charCodeAt(_position);
        if (ch === 0 || is_WS_OR_EOL(ch)) {
          return true;
        }
      }
      return false;
    }
    function writeFoldedLines(state, count) {
      if (count === 1) {
        state.result += " ";
      } else if (count > 1) {
        state.result += common.repeat("\n", count - 1);
      }
    }
    function readPlainScalar(state, nodeIndent, withinFlowCollection) {
      var preceding, following, captureStart, captureEnd, hasPendingContent, _line, _lineStart, _lineIndent, _kind = state.kind, _result = state.result, ch;
      ch = state.input.charCodeAt(state.position);
      if (is_WS_OR_EOL(ch) || is_FLOW_INDICATOR(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) {
        return false;
      }
      if (ch === 63 || ch === 45) {
        following = state.input.charCodeAt(state.position + 1);
        if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
          return false;
        }
      }
      state.kind = "scalar";
      state.result = "";
      captureStart = captureEnd = state.position;
      hasPendingContent = false;
      while (ch !== 0) {
        if (ch === 58) {
          following = state.input.charCodeAt(state.position + 1);
          if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
            break;
          }
        } else if (ch === 35) {
          preceding = state.input.charCodeAt(state.position - 1);
          if (is_WS_OR_EOL(preceding)) {
            break;
          }
        } else if (state.position === state.lineStart && testDocumentSeparator(state) || withinFlowCollection && is_FLOW_INDICATOR(ch)) {
          break;
        } else if (is_EOL(ch)) {
          _line = state.line;
          _lineStart = state.lineStart;
          _lineIndent = state.lineIndent;
          skipSeparationSpace(state, false, -1);
          if (state.lineIndent >= nodeIndent) {
            hasPendingContent = true;
            ch = state.input.charCodeAt(state.position);
            continue;
          } else {
            state.position = captureEnd;
            state.line = _line;
            state.lineStart = _lineStart;
            state.lineIndent = _lineIndent;
            break;
          }
        }
        if (hasPendingContent) {
          captureSegment(state, captureStart, captureEnd, false);
          writeFoldedLines(state, state.line - _line);
          captureStart = captureEnd = state.position;
          hasPendingContent = false;
        }
        if (!is_WHITE_SPACE(ch)) {
          captureEnd = state.position + 1;
        }
        ch = state.input.charCodeAt(++state.position);
      }
      captureSegment(state, captureStart, captureEnd, false);
      if (state.result) {
        return true;
      }
      state.kind = _kind;
      state.result = _result;
      return false;
    }
    function readSingleQuotedScalar(state, nodeIndent) {
      var ch, captureStart, captureEnd;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 39) {
        return false;
      }
      state.kind = "scalar";
      state.result = "";
      state.position++;
      captureStart = captureEnd = state.position;
      while ((ch = state.input.charCodeAt(state.position)) !== 0) {
        if (ch === 39) {
          captureSegment(state, captureStart, state.position, true);
          ch = state.input.charCodeAt(++state.position);
          if (ch === 39) {
            captureStart = state.position;
            state.position++;
            captureEnd = state.position;
          } else {
            return true;
          }
        } else if (is_EOL(ch)) {
          captureSegment(state, captureStart, captureEnd, true);
          writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
          captureStart = captureEnd = state.position;
        } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
          throwError(state, "unexpected end of the document within a single quoted scalar");
        } else {
          state.position++;
          captureEnd = state.position;
        }
      }
      throwError(state, "unexpected end of the stream within a single quoted scalar");
    }
    function readDoubleQuotedScalar(state, nodeIndent) {
      var captureStart, captureEnd, hexLength, hexResult, tmp, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 34) {
        return false;
      }
      state.kind = "scalar";
      state.result = "";
      state.position++;
      captureStart = captureEnd = state.position;
      while ((ch = state.input.charCodeAt(state.position)) !== 0) {
        if (ch === 34) {
          captureSegment(state, captureStart, state.position, true);
          state.position++;
          return true;
        } else if (ch === 92) {
          captureSegment(state, captureStart, state.position, true);
          ch = state.input.charCodeAt(++state.position);
          if (is_EOL(ch)) {
            skipSeparationSpace(state, false, nodeIndent);
          } else if (ch < 256 && simpleEscapeCheck[ch]) {
            state.result += simpleEscapeMap[ch];
            state.position++;
          } else if ((tmp = escapedHexLen(ch)) > 0) {
            hexLength = tmp;
            hexResult = 0;
            for (; hexLength > 0; hexLength--) {
              ch = state.input.charCodeAt(++state.position);
              if ((tmp = fromHexCode(ch)) >= 0) {
                hexResult = (hexResult << 4) + tmp;
              } else {
                throwError(state, "expected hexadecimal character");
              }
            }
            state.result += charFromCodepoint(hexResult);
            state.position++;
          } else {
            throwError(state, "unknown escape sequence");
          }
          captureStart = captureEnd = state.position;
        } else if (is_EOL(ch)) {
          captureSegment(state, captureStart, captureEnd, true);
          writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
          captureStart = captureEnd = state.position;
        } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
          throwError(state, "unexpected end of the document within a double quoted scalar");
        } else {
          state.position++;
          captureEnd = state.position;
        }
      }
      throwError(state, "unexpected end of the stream within a double quoted scalar");
    }
    function readFlowCollection(state, nodeIndent) {
      var readNext = true, _line, _tag = state.tag, _result, _anchor = state.anchor, following, terminator, isPair, isExplicitPair, isMapping, overridableKeys = {}, keyNode, keyTag, valueNode, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch === 91) {
        terminator = 93;
        isMapping = false;
        _result = [];
      } else if (ch === 123) {
        terminator = 125;
        isMapping = true;
        _result = {};
      } else {
        return false;
      }
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = _result;
      }
      ch = state.input.charCodeAt(++state.position);
      while (ch !== 0) {
        skipSeparationSpace(state, true, nodeIndent);
        ch = state.input.charCodeAt(state.position);
        if (ch === terminator) {
          state.position++;
          state.tag = _tag;
          state.anchor = _anchor;
          state.kind = isMapping ? "mapping" : "sequence";
          state.result = _result;
          return true;
        } else if (!readNext) {
          throwError(state, "missed comma between flow collection entries");
        }
        keyTag = keyNode = valueNode = null;
        isPair = isExplicitPair = false;
        if (ch === 63) {
          following = state.input.charCodeAt(state.position + 1);
          if (is_WS_OR_EOL(following)) {
            isPair = isExplicitPair = true;
            state.position++;
            skipSeparationSpace(state, true, nodeIndent);
          }
        }
        _line = state.line;
        composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
        keyTag = state.tag;
        keyNode = state.result;
        skipSeparationSpace(state, true, nodeIndent);
        ch = state.input.charCodeAt(state.position);
        if ((isExplicitPair || state.line === _line) && ch === 58) {
          isPair = true;
          ch = state.input.charCodeAt(++state.position);
          skipSeparationSpace(state, true, nodeIndent);
          composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
          valueNode = state.result;
        }
        if (isMapping) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode);
        } else if (isPair) {
          _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode));
        } else {
          _result.push(keyNode);
        }
        skipSeparationSpace(state, true, nodeIndent);
        ch = state.input.charCodeAt(state.position);
        if (ch === 44) {
          readNext = true;
          ch = state.input.charCodeAt(++state.position);
        } else {
          readNext = false;
        }
      }
      throwError(state, "unexpected end of the stream within a flow collection");
    }
    function readBlockScalar(state, nodeIndent) {
      var captureStart, folding, chomping = CHOMPING_CLIP, didReadContent = false, detectedIndent = false, textIndent = nodeIndent, emptyLines = 0, atMoreIndented = false, tmp, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch === 124) {
        folding = false;
      } else if (ch === 62) {
        folding = true;
      } else {
        return false;
      }
      state.kind = "scalar";
      state.result = "";
      while (ch !== 0) {
        ch = state.input.charCodeAt(++state.position);
        if (ch === 43 || ch === 45) {
          if (CHOMPING_CLIP === chomping) {
            chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
          } else {
            throwError(state, "repeat of a chomping mode identifier");
          }
        } else if ((tmp = fromDecimalCode(ch)) >= 0) {
          if (tmp === 0) {
            throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
          } else if (!detectedIndent) {
            textIndent = nodeIndent + tmp - 1;
            detectedIndent = true;
          } else {
            throwError(state, "repeat of an indentation width identifier");
          }
        } else {
          break;
        }
      }
      if (is_WHITE_SPACE(ch)) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (is_WHITE_SPACE(ch));
        if (ch === 35) {
          do {
            ch = state.input.charCodeAt(++state.position);
          } while (!is_EOL(ch) && ch !== 0);
        }
      }
      while (ch !== 0) {
        readLineBreak(state);
        state.lineIndent = 0;
        ch = state.input.charCodeAt(state.position);
        while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
          state.lineIndent++;
          ch = state.input.charCodeAt(++state.position);
        }
        if (!detectedIndent && state.lineIndent > textIndent) {
          textIndent = state.lineIndent;
        }
        if (is_EOL(ch)) {
          emptyLines++;
          continue;
        }
        if (state.lineIndent < textIndent) {
          if (chomping === CHOMPING_KEEP) {
            state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
          } else if (chomping === CHOMPING_CLIP) {
            if (didReadContent) {
              state.result += "\n";
            }
          }
          break;
        }
        if (folding) {
          if (is_WHITE_SPACE(ch)) {
            atMoreIndented = true;
            state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
          } else if (atMoreIndented) {
            atMoreIndented = false;
            state.result += common.repeat("\n", emptyLines + 1);
          } else if (emptyLines === 0) {
            if (didReadContent) {
              state.result += " ";
            }
          } else {
            state.result += common.repeat("\n", emptyLines);
          }
        } else {
          state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
        }
        didReadContent = true;
        detectedIndent = true;
        emptyLines = 0;
        captureStart = state.position;
        while (!is_EOL(ch) && ch !== 0) {
          ch = state.input.charCodeAt(++state.position);
        }
        captureSegment(state, captureStart, state.position, false);
      }
      return true;
    }
    function readBlockSequence(state, nodeIndent) {
      var _line, _tag = state.tag, _anchor = state.anchor, _result = [], following, detected = false, ch;
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = _result;
      }
      ch = state.input.charCodeAt(state.position);
      while (ch !== 0) {
        if (ch !== 45) {
          break;
        }
        following = state.input.charCodeAt(state.position + 1);
        if (!is_WS_OR_EOL(following)) {
          break;
        }
        detected = true;
        state.position++;
        if (skipSeparationSpace(state, true, -1)) {
          if (state.lineIndent <= nodeIndent) {
            _result.push(null);
            ch = state.input.charCodeAt(state.position);
            continue;
          }
        }
        _line = state.line;
        composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
        _result.push(state.result);
        skipSeparationSpace(state, true, -1);
        ch = state.input.charCodeAt(state.position);
        if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
          throwError(state, "bad indentation of a sequence entry");
        } else if (state.lineIndent < nodeIndent) {
          break;
        }
      }
      if (detected) {
        state.tag = _tag;
        state.anchor = _anchor;
        state.kind = "sequence";
        state.result = _result;
        return true;
      }
      return false;
    }
    function readBlockMapping(state, nodeIndent, flowIndent) {
      var following, allowCompact, _line, _pos, _tag = state.tag, _anchor = state.anchor, _result = {}, overridableKeys = {}, keyTag = null, keyNode = null, valueNode = null, atExplicitKey = false, detected = false, ch;
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = _result;
      }
      ch = state.input.charCodeAt(state.position);
      while (ch !== 0) {
        following = state.input.charCodeAt(state.position + 1);
        _line = state.line;
        _pos = state.position;
        if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
          if (ch === 63) {
            if (atExplicitKey) {
              storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null);
              keyTag = keyNode = valueNode = null;
            }
            detected = true;
            atExplicitKey = true;
            allowCompact = true;
          } else if (atExplicitKey) {
            atExplicitKey = false;
            allowCompact = true;
          } else {
            throwError(state, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
          }
          state.position += 1;
          ch = following;
        } else if (composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
          if (state.line === _line) {
            ch = state.input.charCodeAt(state.position);
            while (is_WHITE_SPACE(ch)) {
              ch = state.input.charCodeAt(++state.position);
            }
            if (ch === 58) {
              ch = state.input.charCodeAt(++state.position);
              if (!is_WS_OR_EOL(ch)) {
                throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
              }
              if (atExplicitKey) {
                storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null);
                keyTag = keyNode = valueNode = null;
              }
              detected = true;
              atExplicitKey = false;
              allowCompact = false;
              keyTag = state.tag;
              keyNode = state.result;
            } else if (detected) {
              throwError(state, "can not read an implicit mapping pair; a colon is missed");
            } else {
              state.tag = _tag;
              state.anchor = _anchor;
              return true;
            }
          } else if (detected) {
            throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
          } else {
            state.tag = _tag;
            state.anchor = _anchor;
            return true;
          }
        } else {
          break;
        }
        if (state.line === _line || state.lineIndent > nodeIndent) {
          if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
            if (atExplicitKey) {
              keyNode = state.result;
            } else {
              valueNode = state.result;
            }
          }
          if (!atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _pos);
            keyTag = keyNode = valueNode = null;
          }
          skipSeparationSpace(state, true, -1);
          ch = state.input.charCodeAt(state.position);
        }
        if (state.lineIndent > nodeIndent && ch !== 0) {
          throwError(state, "bad indentation of a mapping entry");
        } else if (state.lineIndent < nodeIndent) {
          break;
        }
      }
      if (atExplicitKey) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null);
      }
      if (detected) {
        state.tag = _tag;
        state.anchor = _anchor;
        state.kind = "mapping";
        state.result = _result;
      }
      return detected;
    }
    function readTagProperty(state) {
      var _position, isVerbatim = false, isNamed = false, tagHandle, tagName, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 33) return false;
      if (state.tag !== null) {
        throwError(state, "duplication of a tag property");
      }
      ch = state.input.charCodeAt(++state.position);
      if (ch === 60) {
        isVerbatim = true;
        ch = state.input.charCodeAt(++state.position);
      } else if (ch === 33) {
        isNamed = true;
        tagHandle = "!!";
        ch = state.input.charCodeAt(++state.position);
      } else {
        tagHandle = "!";
      }
      _position = state.position;
      if (isVerbatim) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (ch !== 0 && ch !== 62);
        if (state.position < state.length) {
          tagName = state.input.slice(_position, state.position);
          ch = state.input.charCodeAt(++state.position);
        } else {
          throwError(state, "unexpected end of the stream within a verbatim tag");
        }
      } else {
        while (ch !== 0 && !is_WS_OR_EOL(ch)) {
          if (ch === 33) {
            if (!isNamed) {
              tagHandle = state.input.slice(_position - 1, state.position + 1);
              if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
                throwError(state, "named tag handle cannot contain such characters");
              }
              isNamed = true;
              _position = state.position + 1;
            } else {
              throwError(state, "tag suffix cannot contain exclamation marks");
            }
          }
          ch = state.input.charCodeAt(++state.position);
        }
        tagName = state.input.slice(_position, state.position);
        if (PATTERN_FLOW_INDICATORS.test(tagName)) {
          throwError(state, "tag suffix cannot contain flow indicator characters");
        }
      }
      if (tagName && !PATTERN_TAG_URI.test(tagName)) {
        throwError(state, "tag name cannot contain such characters: " + tagName);
      }
      if (isVerbatim) {
        state.tag = tagName;
      } else if (_hasOwnProperty.call(state.tagMap, tagHandle)) {
        state.tag = state.tagMap[tagHandle] + tagName;
      } else if (tagHandle === "!") {
        state.tag = "!" + tagName;
      } else if (tagHandle === "!!") {
        state.tag = "tag:yaml.org,2002:" + tagName;
      } else {
        throwError(state, 'undeclared tag handle "' + tagHandle + '"');
      }
      return true;
    }
    function readAnchorProperty(state) {
      var _position, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 38) return false;
      if (state.anchor !== null) {
        throwError(state, "duplication of an anchor property");
      }
      ch = state.input.charCodeAt(++state.position);
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      if (state.position === _position) {
        throwError(state, "name of an anchor node must contain at least one character");
      }
      state.anchor = state.input.slice(_position, state.position);
      return true;
    }
    function readAlias(state) {
      var _position, alias, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 42) return false;
      ch = state.input.charCodeAt(++state.position);
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      if (state.position === _position) {
        throwError(state, "name of an alias node must contain at least one character");
      }
      alias = state.input.slice(_position, state.position);
      if (!_hasOwnProperty.call(state.anchorMap, alias)) {
        throwError(state, 'unidentified alias "' + alias + '"');
      }
      state.result = state.anchorMap[alias];
      skipSeparationSpace(state, true, -1);
      return true;
    }
    function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
      var allowBlockStyles, allowBlockScalars, allowBlockCollections, indentStatus = 1, atNewLine = false, hasContent = false, typeIndex, typeQuantity, type, flowIndent, blockIndent;
      if (state.listener !== null) {
        state.listener("open", state);
      }
      state.tag = null;
      state.anchor = null;
      state.kind = null;
      state.result = null;
      allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
      if (allowToSeek) {
        if (skipSeparationSpace(state, true, -1)) {
          atNewLine = true;
          if (state.lineIndent > parentIndent) {
            indentStatus = 1;
          } else if (state.lineIndent === parentIndent) {
            indentStatus = 0;
          } else if (state.lineIndent < parentIndent) {
            indentStatus = -1;
          }
        }
      }
      if (indentStatus === 1) {
        while (readTagProperty(state) || readAnchorProperty(state)) {
          if (skipSeparationSpace(state, true, -1)) {
            atNewLine = true;
            allowBlockCollections = allowBlockStyles;
            if (state.lineIndent > parentIndent) {
              indentStatus = 1;
            } else if (state.lineIndent === parentIndent) {
              indentStatus = 0;
            } else if (state.lineIndent < parentIndent) {
              indentStatus = -1;
            }
          } else {
            allowBlockCollections = false;
          }
        }
      }
      if (allowBlockCollections) {
        allowBlockCollections = atNewLine || allowCompact;
      }
      if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
        if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) {
          flowIndent = parentIndent;
        } else {
          flowIndent = parentIndent + 1;
        }
        blockIndent = state.position - state.lineStart;
        if (indentStatus === 1) {
          if (allowBlockCollections && (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent)) || readFlowCollection(state, flowIndent)) {
            hasContent = true;
          } else {
            if (allowBlockScalars && readBlockScalar(state, flowIndent) || readSingleQuotedScalar(state, flowIndent) || readDoubleQuotedScalar(state, flowIndent)) {
              hasContent = true;
            } else if (readAlias(state)) {
              hasContent = true;
              if (state.tag !== null || state.anchor !== null) {
                throwError(state, "alias node should not have any properties");
              }
            } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
              hasContent = true;
              if (state.tag === null) {
                state.tag = "?";
              }
            }
            if (state.anchor !== null) {
              state.anchorMap[state.anchor] = state.result;
            }
          }
        } else if (indentStatus === 0) {
          hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
        }
      }
      if (state.tag !== null && state.tag !== "!") {
        if (state.tag === "?") {
          if (state.result !== null && state.kind !== "scalar") {
            throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
          }
          for (typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
            type = state.implicitTypes[typeIndex];
            if (type.resolve(state.result)) {
              state.result = type.construct(state.result);
              state.tag = type.tag;
              if (state.anchor !== null) {
                state.anchorMap[state.anchor] = state.result;
              }
              break;
            }
          }
        } else if (_hasOwnProperty.call(state.typeMap[state.kind || "fallback"], state.tag)) {
          type = state.typeMap[state.kind || "fallback"][state.tag];
          if (state.result !== null && type.kind !== state.kind) {
            throwError(state, "unacceptable node kind for !<" + state.tag + '> tag; it should be "' + type.kind + '", not "' + state.kind + '"');
          }
          if (!type.resolve(state.result)) {
            throwError(state, "cannot resolve a node with !<" + state.tag + "> explicit tag");
          } else {
            state.result = type.construct(state.result);
            if (state.anchor !== null) {
              state.anchorMap[state.anchor] = state.result;
            }
          }
        } else {
          throwError(state, "unknown tag !<" + state.tag + ">");
        }
      }
      if (state.listener !== null) {
        state.listener("close", state);
      }
      return state.tag !== null || state.anchor !== null || hasContent;
    }
    function readDocument(state) {
      var documentStart = state.position, _position, directiveName, directiveArgs, hasDirectives = false, ch;
      state.version = null;
      state.checkLineBreaks = state.legacy;
      state.tagMap = {};
      state.anchorMap = {};
      while ((ch = state.input.charCodeAt(state.position)) !== 0) {
        skipSeparationSpace(state, true, -1);
        ch = state.input.charCodeAt(state.position);
        if (state.lineIndent > 0 || ch !== 37) {
          break;
        }
        hasDirectives = true;
        ch = state.input.charCodeAt(++state.position);
        _position = state.position;
        while (ch !== 0 && !is_WS_OR_EOL(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        directiveName = state.input.slice(_position, state.position);
        directiveArgs = [];
        if (directiveName.length < 1) {
          throwError(state, "directive name must not be less than one character in length");
        }
        while (ch !== 0) {
          while (is_WHITE_SPACE(ch)) {
            ch = state.input.charCodeAt(++state.position);
          }
          if (ch === 35) {
            do {
              ch = state.input.charCodeAt(++state.position);
            } while (ch !== 0 && !is_EOL(ch));
            break;
          }
          if (is_EOL(ch)) break;
          _position = state.position;
          while (ch !== 0 && !is_WS_OR_EOL(ch)) {
            ch = state.input.charCodeAt(++state.position);
          }
          directiveArgs.push(state.input.slice(_position, state.position));
        }
        if (ch !== 0) readLineBreak(state);
        if (_hasOwnProperty.call(directiveHandlers, directiveName)) {
          directiveHandlers[directiveName](state, directiveName, directiveArgs);
        } else {
          throwWarning(state, 'unknown document directive "' + directiveName + '"');
        }
      }
      skipSeparationSpace(state, true, -1);
      if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45) {
        state.position += 3;
        skipSeparationSpace(state, true, -1);
      } else if (hasDirectives) {
        throwError(state, "directives end mark is expected");
      }
      composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
      skipSeparationSpace(state, true, -1);
      if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) {
        throwWarning(state, "non-ASCII line breaks are interpreted as content");
      }
      state.documents.push(state.result);
      if (state.position === state.lineStart && testDocumentSeparator(state)) {
        if (state.input.charCodeAt(state.position) === 46) {
          state.position += 3;
          skipSeparationSpace(state, true, -1);
        }
        return;
      }
      if (state.position < state.length - 1) {
        throwError(state, "end of the stream or a document separator is expected");
      } else {
        return;
      }
    }
    function loadDocuments(input, options2) {
      input = String(input);
      options2 = options2 || {};
      if (input.length !== 0) {
        if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) {
          input += "\n";
        }
        if (input.charCodeAt(0) === 65279) {
          input = input.slice(1);
        }
      }
      var state = new State(input, options2);
      var nullpos = input.indexOf("\0");
      if (nullpos !== -1) {
        state.position = nullpos;
        throwError(state, "null byte is not allowed in input");
      }
      state.input += "\0";
      while (state.input.charCodeAt(state.position) === 32) {
        state.lineIndent += 1;
        state.position += 1;
      }
      while (state.position < state.length - 1) {
        readDocument(state);
      }
      return state.documents;
    }
    function loadAll(input, iterator, options2) {
      if (iterator !== null && typeof iterator === "object" && typeof options2 === "undefined") {
        options2 = iterator;
        iterator = null;
      }
      var documents = loadDocuments(input, options2);
      if (typeof iterator !== "function") {
        return documents;
      }
      for (var index = 0, length = documents.length; index < length; index += 1) {
        iterator(documents[index]);
      }
    }
    function load(input, options2) {
      var documents = loadDocuments(input, options2);
      if (documents.length === 0) {
        return void 0;
      } else if (documents.length === 1) {
        return documents[0];
      }
      throw new YAMLException("expected a single document in the stream, but found more");
    }
    function safeLoadAll(input, iterator, options2) {
      if (typeof iterator === "object" && iterator !== null && typeof options2 === "undefined") {
        options2 = iterator;
        iterator = null;
      }
      return loadAll(input, iterator, common.extend({ schema: DEFAULT_SAFE_SCHEMA }, options2));
    }
    function safeLoad(input, options2) {
      return load(input, common.extend({ schema: DEFAULT_SAFE_SCHEMA }, options2));
    }
    module2.exports.loadAll = loadAll;
    module2.exports.load = load;
    module2.exports.safeLoadAll = safeLoadAll;
    module2.exports.safeLoad = safeLoad;
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/dumper.js
var require_dumper = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml/dumper.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var YAMLException = require_exception();
    var DEFAULT_FULL_SCHEMA = require_default_full();
    var DEFAULT_SAFE_SCHEMA = require_default_safe();
    var _toString = Object.prototype.toString;
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    var CHAR_TAB = 9;
    var CHAR_LINE_FEED = 10;
    var CHAR_CARRIAGE_RETURN = 13;
    var CHAR_SPACE = 32;
    var CHAR_EXCLAMATION = 33;
    var CHAR_DOUBLE_QUOTE = 34;
    var CHAR_SHARP = 35;
    var CHAR_PERCENT = 37;
    var CHAR_AMPERSAND = 38;
    var CHAR_SINGLE_QUOTE = 39;
    var CHAR_ASTERISK = 42;
    var CHAR_COMMA = 44;
    var CHAR_MINUS = 45;
    var CHAR_COLON = 58;
    var CHAR_EQUALS = 61;
    var CHAR_GREATER_THAN = 62;
    var CHAR_QUESTION = 63;
    var CHAR_COMMERCIAL_AT = 64;
    var CHAR_LEFT_SQUARE_BRACKET = 91;
    var CHAR_RIGHT_SQUARE_BRACKET = 93;
    var CHAR_GRAVE_ACCENT = 96;
    var CHAR_LEFT_CURLY_BRACKET = 123;
    var CHAR_VERTICAL_LINE = 124;
    var CHAR_RIGHT_CURLY_BRACKET = 125;
    var ESCAPE_SEQUENCES = {};
    ESCAPE_SEQUENCES[0] = "\\0";
    ESCAPE_SEQUENCES[7] = "\\a";
    ESCAPE_SEQUENCES[8] = "\\b";
    ESCAPE_SEQUENCES[9] = "\\t";
    ESCAPE_SEQUENCES[10] = "\\n";
    ESCAPE_SEQUENCES[11] = "\\v";
    ESCAPE_SEQUENCES[12] = "\\f";
    ESCAPE_SEQUENCES[13] = "\\r";
    ESCAPE_SEQUENCES[27] = "\\e";
    ESCAPE_SEQUENCES[34] = '\\"';
    ESCAPE_SEQUENCES[92] = "\\\\";
    ESCAPE_SEQUENCES[133] = "\\N";
    ESCAPE_SEQUENCES[160] = "\\_";
    ESCAPE_SEQUENCES[8232] = "\\L";
    ESCAPE_SEQUENCES[8233] = "\\P";
    var DEPRECATED_BOOLEANS_SYNTAX = [
      "y",
      "Y",
      "yes",
      "Yes",
      "YES",
      "on",
      "On",
      "ON",
      "n",
      "N",
      "no",
      "No",
      "NO",
      "off",
      "Off",
      "OFF"
    ];
    function compileStyleMap(schema, map) {
      var result2, keys, index, length, tag, style, type;
      if (map === null) return {};
      result2 = {};
      keys = Object.keys(map);
      for (index = 0, length = keys.length; index < length; index += 1) {
        tag = keys[index];
        style = String(map[tag]);
        if (tag.slice(0, 2) === "!!") {
          tag = "tag:yaml.org,2002:" + tag.slice(2);
        }
        type = schema.compiledTypeMap["fallback"][tag];
        if (type && _hasOwnProperty.call(type.styleAliases, style)) {
          style = type.styleAliases[style];
        }
        result2[tag] = style;
      }
      return result2;
    }
    function encodeHex(character) {
      var string, handle, length;
      string = character.toString(16).toUpperCase();
      if (character <= 255) {
        handle = "x";
        length = 2;
      } else if (character <= 65535) {
        handle = "u";
        length = 4;
      } else if (character <= 4294967295) {
        handle = "U";
        length = 8;
      } else {
        throw new YAMLException("code point within a string may not be greater than 0xFFFFFFFF");
      }
      return "\\" + handle + common.repeat("0", length - string.length) + string;
    }
    function State(options2) {
      this.schema = options2["schema"] || DEFAULT_FULL_SCHEMA;
      this.indent = Math.max(1, options2["indent"] || 2);
      this.noArrayIndent = options2["noArrayIndent"] || false;
      this.skipInvalid = options2["skipInvalid"] || false;
      this.flowLevel = common.isNothing(options2["flowLevel"]) ? -1 : options2["flowLevel"];
      this.styleMap = compileStyleMap(this.schema, options2["styles"] || null);
      this.sortKeys = options2["sortKeys"] || false;
      this.lineWidth = options2["lineWidth"] || 80;
      this.noRefs = options2["noRefs"] || false;
      this.noCompatMode = options2["noCompatMode"] || false;
      this.condenseFlow = options2["condenseFlow"] || false;
      this.implicitTypes = this.schema.compiledImplicit;
      this.explicitTypes = this.schema.compiledExplicit;
      this.tag = null;
      this.result = "";
      this.duplicates = [];
      this.usedDuplicates = null;
    }
    function indentString(string, spaces) {
      var ind = common.repeat(" ", spaces), position = 0, next = -1, result2 = "", line, length = string.length;
      while (position < length) {
        next = string.indexOf("\n", position);
        if (next === -1) {
          line = string.slice(position);
          position = length;
        } else {
          line = string.slice(position, next + 1);
          position = next + 1;
        }
        if (line.length && line !== "\n") result2 += ind;
        result2 += line;
      }
      return result2;
    }
    function generateNextLine(state, level) {
      return "\n" + common.repeat(" ", state.indent * level);
    }
    function testImplicitResolving(state, str2) {
      var index, length, type;
      for (index = 0, length = state.implicitTypes.length; index < length; index += 1) {
        type = state.implicitTypes[index];
        if (type.resolve(str2)) {
          return true;
        }
      }
      return false;
    }
    function isWhitespace(c) {
      return c === CHAR_SPACE || c === CHAR_TAB;
    }
    function isPrintable(c) {
      return 32 <= c && c <= 126 || 161 <= c && c <= 55295 && c !== 8232 && c !== 8233 || 57344 <= c && c <= 65533 && c !== 65279 || 65536 <= c && c <= 1114111;
    }
    function isNsChar(c) {
      return isPrintable(c) && !isWhitespace(c) && c !== 65279 && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
    }
    function isPlainSafe(c, prev) {
      return isPrintable(c) && c !== 65279 && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_COLON && (c !== CHAR_SHARP || prev && isNsChar(prev));
    }
    function isPlainSafeFirst(c) {
      return isPrintable(c) && c !== 65279 && !isWhitespace(c) && c !== CHAR_MINUS && c !== CHAR_QUESTION && c !== CHAR_COLON && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_SHARP && c !== CHAR_AMPERSAND && c !== CHAR_ASTERISK && c !== CHAR_EXCLAMATION && c !== CHAR_VERTICAL_LINE && c !== CHAR_EQUALS && c !== CHAR_GREATER_THAN && c !== CHAR_SINGLE_QUOTE && c !== CHAR_DOUBLE_QUOTE && c !== CHAR_PERCENT && c !== CHAR_COMMERCIAL_AT && c !== CHAR_GRAVE_ACCENT;
    }
    function needIndentIndicator(string) {
      var leadingSpaceRe = /^\n* /;
      return leadingSpaceRe.test(string);
    }
    var STYLE_PLAIN = 1;
    var STYLE_SINGLE = 2;
    var STYLE_LITERAL = 3;
    var STYLE_FOLDED = 4;
    var STYLE_DOUBLE = 5;
    function chooseScalarStyle(string, singleLineOnly, indentPerLevel, lineWidth, testAmbiguousType) {
      var i;
      var char, prev_char;
      var hasLineBreak = false;
      var hasFoldableLine = false;
      var shouldTrackWidth = lineWidth !== -1;
      var previousLineBreak = -1;
      var plain = isPlainSafeFirst(string.charCodeAt(0)) && !isWhitespace(string.charCodeAt(string.length - 1));
      if (singleLineOnly) {
        for (i = 0; i < string.length; i++) {
          char = string.charCodeAt(i);
          if (!isPrintable(char)) {
            return STYLE_DOUBLE;
          }
          prev_char = i > 0 ? string.charCodeAt(i - 1) : null;
          plain = plain && isPlainSafe(char, prev_char);
        }
      } else {
        for (i = 0; i < string.length; i++) {
          char = string.charCodeAt(i);
          if (char === CHAR_LINE_FEED) {
            hasLineBreak = true;
            if (shouldTrackWidth) {
              hasFoldableLine = hasFoldableLine || // Foldable line = too long, and not more-indented.
              i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
              previousLineBreak = i;
            }
          } else if (!isPrintable(char)) {
            return STYLE_DOUBLE;
          }
          prev_char = i > 0 ? string.charCodeAt(i - 1) : null;
          plain = plain && isPlainSafe(char, prev_char);
        }
        hasFoldableLine = hasFoldableLine || shouldTrackWidth && (i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ");
      }
      if (!hasLineBreak && !hasFoldableLine) {
        return plain && !testAmbiguousType(string) ? STYLE_PLAIN : STYLE_SINGLE;
      }
      if (indentPerLevel > 9 && needIndentIndicator(string)) {
        return STYLE_DOUBLE;
      }
      return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
    }
    function writeScalar(state, string, level, iskey) {
      state.dump = (function() {
        if (string.length === 0) {
          return "''";
        }
        if (!state.noCompatMode && DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1) {
          return "'" + string + "'";
        }
        var indent = state.indent * Math.max(1, level);
        var lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
        var singleLineOnly = iskey || state.flowLevel > -1 && level >= state.flowLevel;
        function testAmbiguity(string2) {
          return testImplicitResolving(state, string2);
        }
        switch (chooseScalarStyle(string, singleLineOnly, state.indent, lineWidth, testAmbiguity)) {
          case STYLE_PLAIN:
            return string;
          case STYLE_SINGLE:
            return "'" + string.replace(/'/g, "''") + "'";
          case STYLE_LITERAL:
            return "|" + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
          case STYLE_FOLDED:
            return ">" + blockHeader(string, state.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
          case STYLE_DOUBLE:
            return '"' + escapeString(string, lineWidth) + '"';
          default:
            throw new YAMLException("impossible error: invalid scalar style");
        }
      })();
    }
    function blockHeader(string, indentPerLevel) {
      var indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : "";
      var clip = string[string.length - 1] === "\n";
      var keep = clip && (string[string.length - 2] === "\n" || string === "\n");
      var chomp = keep ? "+" : clip ? "" : "-";
      return indentIndicator + chomp + "\n";
    }
    function dropEndingNewline(string) {
      return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
    }
    function foldString(string, width) {
      var lineRe = /(\n+)([^\n]*)/g;
      var result2 = (function() {
        var nextLF = string.indexOf("\n");
        nextLF = nextLF !== -1 ? nextLF : string.length;
        lineRe.lastIndex = nextLF;
        return foldLine(string.slice(0, nextLF), width);
      })();
      var prevMoreIndented = string[0] === "\n" || string[0] === " ";
      var moreIndented;
      var match;
      while (match = lineRe.exec(string)) {
        var prefix = match[1], line = match[2];
        moreIndented = line[0] === " ";
        result2 += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
        prevMoreIndented = moreIndented;
      }
      return result2;
    }
    function foldLine(line, width) {
      if (line === "" || line[0] === " ") return line;
      var breakRe = / [^ ]/g;
      var match;
      var start = 0, end, curr = 0, next = 0;
      var result2 = "";
      while (match = breakRe.exec(line)) {
        next = match.index;
        if (next - start > width) {
          end = curr > start ? curr : next;
          result2 += "\n" + line.slice(start, end);
          start = end + 1;
        }
        curr = next;
      }
      result2 += "\n";
      if (line.length - start > width && curr > start) {
        result2 += line.slice(start, curr) + "\n" + line.slice(curr + 1);
      } else {
        result2 += line.slice(start);
      }
      return result2.slice(1);
    }
    function escapeString(string) {
      var result2 = "";
      var char, nextChar;
      var escapeSeq;
      for (var i = 0; i < string.length; i++) {
        char = string.charCodeAt(i);
        if (char >= 55296 && char <= 56319) {
          nextChar = string.charCodeAt(i + 1);
          if (nextChar >= 56320 && nextChar <= 57343) {
            result2 += encodeHex((char - 55296) * 1024 + nextChar - 56320 + 65536);
            i++;
            continue;
          }
        }
        escapeSeq = ESCAPE_SEQUENCES[char];
        result2 += !escapeSeq && isPrintable(char) ? string[i] : escapeSeq || encodeHex(char);
      }
      return result2;
    }
    function writeFlowSequence(state, level, object) {
      var _result = "", _tag = state.tag, index, length;
      for (index = 0, length = object.length; index < length; index += 1) {
        if (writeNode(state, level, object[index], false, false)) {
          if (index !== 0) _result += "," + (!state.condenseFlow ? " " : "");
          _result += state.dump;
        }
      }
      state.tag = _tag;
      state.dump = "[" + _result + "]";
    }
    function writeBlockSequence(state, level, object, compact) {
      var _result = "", _tag = state.tag, index, length;
      for (index = 0, length = object.length; index < length; index += 1) {
        if (writeNode(state, level + 1, object[index], true, true)) {
          if (!compact || index !== 0) {
            _result += generateNextLine(state, level);
          }
          if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
            _result += "-";
          } else {
            _result += "- ";
          }
          _result += state.dump;
        }
      }
      state.tag = _tag;
      state.dump = _result || "[]";
    }
    function writeFlowMapping(state, level, object) {
      var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, pairBuffer;
      for (index = 0, length = objectKeyList.length; index < length; index += 1) {
        pairBuffer = "";
        if (index !== 0) pairBuffer += ", ";
        if (state.condenseFlow) pairBuffer += '"';
        objectKey = objectKeyList[index];
        objectValue = object[objectKey];
        if (!writeNode(state, level, objectKey, false, false)) {
          continue;
        }
        if (state.dump.length > 1024) pairBuffer += "? ";
        pairBuffer += state.dump + (state.condenseFlow ? '"' : "") + ":" + (state.condenseFlow ? "" : " ");
        if (!writeNode(state, level, objectValue, false, false)) {
          continue;
        }
        pairBuffer += state.dump;
        _result += pairBuffer;
      }
      state.tag = _tag;
      state.dump = "{" + _result + "}";
    }
    function writeBlockMapping(state, level, object, compact) {
      var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, explicitPair, pairBuffer;
      if (state.sortKeys === true) {
        objectKeyList.sort();
      } else if (typeof state.sortKeys === "function") {
        objectKeyList.sort(state.sortKeys);
      } else if (state.sortKeys) {
        throw new YAMLException("sortKeys must be a boolean or a function");
      }
      for (index = 0, length = objectKeyList.length; index < length; index += 1) {
        pairBuffer = "";
        if (!compact || index !== 0) {
          pairBuffer += generateNextLine(state, level);
        }
        objectKey = objectKeyList[index];
        objectValue = object[objectKey];
        if (!writeNode(state, level + 1, objectKey, true, true, true)) {
          continue;
        }
        explicitPair = state.tag !== null && state.tag !== "?" || state.dump && state.dump.length > 1024;
        if (explicitPair) {
          if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
            pairBuffer += "?";
          } else {
            pairBuffer += "? ";
          }
        }
        pairBuffer += state.dump;
        if (explicitPair) {
          pairBuffer += generateNextLine(state, level);
        }
        if (!writeNode(state, level + 1, objectValue, true, explicitPair)) {
          continue;
        }
        if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
          pairBuffer += ":";
        } else {
          pairBuffer += ": ";
        }
        pairBuffer += state.dump;
        _result += pairBuffer;
      }
      state.tag = _tag;
      state.dump = _result || "{}";
    }
    function detectType(state, object, explicit) {
      var _result, typeList, index, length, type, style;
      typeList = explicit ? state.explicitTypes : state.implicitTypes;
      for (index = 0, length = typeList.length; index < length; index += 1) {
        type = typeList[index];
        if ((type.instanceOf || type.predicate) && (!type.instanceOf || typeof object === "object" && object instanceof type.instanceOf) && (!type.predicate || type.predicate(object))) {
          state.tag = explicit ? type.tag : "?";
          if (type.represent) {
            style = state.styleMap[type.tag] || type.defaultStyle;
            if (_toString.call(type.represent) === "[object Function]") {
              _result = type.represent(object, style);
            } else if (_hasOwnProperty.call(type.represent, style)) {
              _result = type.represent[style](object, style);
            } else {
              throw new YAMLException("!<" + type.tag + '> tag resolver accepts not "' + style + '" style');
            }
            state.dump = _result;
          }
          return true;
        }
      }
      return false;
    }
    function writeNode(state, level, object, block, compact, iskey) {
      state.tag = null;
      state.dump = object;
      if (!detectType(state, object, false)) {
        detectType(state, object, true);
      }
      var type = _toString.call(state.dump);
      if (block) {
        block = state.flowLevel < 0 || state.flowLevel > level;
      }
      var objectOrArray = type === "[object Object]" || type === "[object Array]", duplicateIndex, duplicate;
      if (objectOrArray) {
        duplicateIndex = state.duplicates.indexOf(object);
        duplicate = duplicateIndex !== -1;
      }
      if (state.tag !== null && state.tag !== "?" || duplicate || state.indent !== 2 && level > 0) {
        compact = false;
      }
      if (duplicate && state.usedDuplicates[duplicateIndex]) {
        state.dump = "*ref_" + duplicateIndex;
      } else {
        if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) {
          state.usedDuplicates[duplicateIndex] = true;
        }
        if (type === "[object Object]") {
          if (block && Object.keys(state.dump).length !== 0) {
            writeBlockMapping(state, level, state.dump, compact);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + state.dump;
            }
          } else {
            writeFlowMapping(state, level, state.dump);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + " " + state.dump;
            }
          }
        } else if (type === "[object Array]") {
          var arrayLevel = state.noArrayIndent && level > 0 ? level - 1 : level;
          if (block && state.dump.length !== 0) {
            writeBlockSequence(state, arrayLevel, state.dump, compact);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + state.dump;
            }
          } else {
            writeFlowSequence(state, arrayLevel, state.dump);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + " " + state.dump;
            }
          }
        } else if (type === "[object String]") {
          if (state.tag !== "?") {
            writeScalar(state, state.dump, level, iskey);
          }
        } else {
          if (state.skipInvalid) return false;
          throw new YAMLException("unacceptable kind of an object to dump " + type);
        }
        if (state.tag !== null && state.tag !== "?") {
          state.dump = "!<" + state.tag + "> " + state.dump;
        }
      }
      return true;
    }
    function getDuplicateReferences(object, state) {
      var objects = [], duplicatesIndexes = [], index, length;
      inspectNode(object, objects, duplicatesIndexes);
      for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
        state.duplicates.push(objects[duplicatesIndexes[index]]);
      }
      state.usedDuplicates = new Array(length);
    }
    function inspectNode(object, objects, duplicatesIndexes) {
      var objectKeyList, index, length;
      if (object !== null && typeof object === "object") {
        index = objects.indexOf(object);
        if (index !== -1) {
          if (duplicatesIndexes.indexOf(index) === -1) {
            duplicatesIndexes.push(index);
          }
        } else {
          objects.push(object);
          if (Array.isArray(object)) {
            for (index = 0, length = object.length; index < length; index += 1) {
              inspectNode(object[index], objects, duplicatesIndexes);
            }
          } else {
            objectKeyList = Object.keys(object);
            for (index = 0, length = objectKeyList.length; index < length; index += 1) {
              inspectNode(object[objectKeyList[index]], objects, duplicatesIndexes);
            }
          }
        }
      }
    }
    function dump(input, options2) {
      options2 = options2 || {};
      var state = new State(options2);
      if (!state.noRefs) getDuplicateReferences(input, state);
      if (writeNode(state, 0, input, true, true)) return state.dump + "\n";
      return "";
    }
    function safeDump(input, options2) {
      return dump(input, common.extend({ schema: DEFAULT_SAFE_SCHEMA }, options2));
    }
    module2.exports.dump = dump;
    module2.exports.safeDump = safeDump;
  }
});

// node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml.js
var require_js_yaml = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/lib/js-yaml.js"(exports2, module2) {
    "use strict";
    var loader = require_loader();
    var dumper = require_dumper();
    function deprecated(name) {
      return function() {
        throw new Error("Function " + name + " is deprecated and cannot be used.");
      };
    }
    module2.exports.Type = require_type();
    module2.exports.Schema = require_schema();
    module2.exports.FAILSAFE_SCHEMA = require_failsafe();
    module2.exports.JSON_SCHEMA = require_json();
    module2.exports.CORE_SCHEMA = require_core();
    module2.exports.DEFAULT_SAFE_SCHEMA = require_default_safe();
    module2.exports.DEFAULT_FULL_SCHEMA = require_default_full();
    module2.exports.load = loader.load;
    module2.exports.loadAll = loader.loadAll;
    module2.exports.safeLoad = loader.safeLoad;
    module2.exports.safeLoadAll = loader.safeLoadAll;
    module2.exports.dump = dumper.dump;
    module2.exports.safeDump = dumper.safeDump;
    module2.exports.YAMLException = require_exception();
    module2.exports.MINIMAL_SCHEMA = require_failsafe();
    module2.exports.SAFE_SCHEMA = require_default_safe();
    module2.exports.DEFAULT_SCHEMA = require_default_full();
    module2.exports.scan = deprecated("scan");
    module2.exports.parse = deprecated("parse");
    module2.exports.compose = deprecated("compose");
    module2.exports.addConstructor = deprecated("addConstructor");
  }
});

// node_modules/gray-matter/node_modules/js-yaml/index.js
var require_js_yaml2 = __commonJS({
  "node_modules/gray-matter/node_modules/js-yaml/index.js"(exports2, module2) {
    "use strict";
    var yaml2 = require_js_yaml();
    module2.exports = yaml2;
  }
});

// node_modules/gray-matter/lib/engines.js
var require_engines = __commonJS({
  "node_modules/gray-matter/lib/engines.js"(exports, module) {
    "use strict";
    var yaml = require_js_yaml2();
    var engines = exports = module.exports;
    engines.yaml = {
      parse: yaml.safeLoad.bind(yaml),
      stringify: yaml.safeDump.bind(yaml)
    };
    engines.json = {
      parse: JSON.parse.bind(JSON),
      stringify: function(obj, options2) {
        const opts = Object.assign({ replacer: null, space: 2 }, options2);
        return JSON.stringify(obj, opts.replacer, opts.space);
      }
    };
    engines.javascript = {
      parse: function parse(str, options, wrap) {
        try {
          if (wrap !== false) {
            str = "(function() {\nreturn " + str.trim() + ";\n}());";
          }
          return eval(str) || {};
        } catch (err) {
          if (wrap !== false && /(unexpected|identifier)/i.test(err.message)) {
            return parse(str, options, false);
          }
          throw new SyntaxError(err);
        }
      },
      stringify: function() {
        throw new Error("stringifying JavaScript is not supported");
      }
    };
  }
});

// node_modules/strip-bom-string/index.js
var require_strip_bom_string = __commonJS({
  "node_modules/strip-bom-string/index.js"(exports2, module2) {
    "use strict";
    module2.exports = function(str2) {
      if (typeof str2 === "string" && str2.charAt(0) === "\uFEFF") {
        return str2.slice(1);
      }
      return str2;
    };
  }
});

// node_modules/gray-matter/lib/utils.js
var require_utils = __commonJS({
  "node_modules/gray-matter/lib/utils.js"(exports2) {
    "use strict";
    var stripBom = require_strip_bom_string();
    var typeOf = require_kind_of();
    exports2.define = function(obj, key, val) {
      Reflect.defineProperty(obj, key, {
        enumerable: false,
        configurable: true,
        writable: true,
        value: val
      });
    };
    exports2.isBuffer = function(val) {
      return typeOf(val) === "buffer";
    };
    exports2.isObject = function(val) {
      return typeOf(val) === "object";
    };
    exports2.toBuffer = function(input) {
      return typeof input === "string" ? Buffer.from(input) : input;
    };
    exports2.toString = function(input) {
      if (exports2.isBuffer(input)) return stripBom(String(input));
      if (typeof input !== "string") {
        throw new TypeError("expected input to be a string or buffer");
      }
      return stripBom(input);
    };
    exports2.arrayify = function(val) {
      return val ? Array.isArray(val) ? val : [val] : [];
    };
    exports2.startsWith = function(str2, substr, len) {
      if (typeof len !== "number") len = substr.length;
      return str2.slice(0, len) === substr;
    };
  }
});

// node_modules/gray-matter/lib/defaults.js
var require_defaults = __commonJS({
  "node_modules/gray-matter/lib/defaults.js"(exports2, module2) {
    "use strict";
    var engines2 = require_engines();
    var utils = require_utils();
    module2.exports = function(options2) {
      const opts = Object.assign({}, options2);
      opts.delimiters = utils.arrayify(opts.delims || opts.delimiters || "---");
      if (opts.delimiters.length === 1) {
        opts.delimiters.push(opts.delimiters[0]);
      }
      opts.language = (opts.language || opts.lang || "yaml").toLowerCase();
      opts.engines = Object.assign({}, engines2, opts.parsers, opts.engines);
      return opts;
    };
  }
});

// node_modules/gray-matter/lib/engine.js
var require_engine = __commonJS({
  "node_modules/gray-matter/lib/engine.js"(exports2, module2) {
    "use strict";
    module2.exports = function(name, options2) {
      let engine = options2.engines[name] || options2.engines[aliase(name)];
      if (typeof engine === "undefined") {
        throw new Error('gray-matter engine "' + name + '" is not registered');
      }
      if (typeof engine === "function") {
        engine = { parse: engine };
      }
      return engine;
    };
    function aliase(name) {
      switch (name.toLowerCase()) {
        case "js":
        case "javascript":
          return "javascript";
        case "coffee":
        case "coffeescript":
        case "cson":
          return "coffee";
        case "yaml":
        case "yml":
          return "yaml";
        default: {
          return name;
        }
      }
    }
  }
});

// node_modules/gray-matter/lib/stringify.js
var require_stringify = __commonJS({
  "node_modules/gray-matter/lib/stringify.js"(exports2, module2) {
    "use strict";
    var typeOf = require_kind_of();
    var getEngine = require_engine();
    var defaults = require_defaults();
    module2.exports = function(file, data, options2) {
      if (data == null && options2 == null) {
        switch (typeOf(file)) {
          case "object":
            data = file.data;
            options2 = {};
            break;
          case "string":
            return file;
          default: {
            throw new TypeError("expected file to be a string or object");
          }
        }
      }
      const str2 = file.content;
      const opts = defaults(options2);
      if (data == null) {
        if (!opts.data) return file;
        data = opts.data;
      }
      const language = file.language || opts.language;
      const engine = getEngine(language, opts);
      if (typeof engine.stringify !== "function") {
        throw new TypeError('expected "' + language + '.stringify" to be a function');
      }
      data = Object.assign({}, file.data, data);
      const open = opts.delimiters[0];
      const close = opts.delimiters[1];
      const matter2 = engine.stringify(data, options2).trim();
      let buf = "";
      if (matter2 !== "{}") {
        buf = newline(open) + newline(matter2) + newline(close);
      }
      if (typeof file.excerpt === "string" && file.excerpt !== "") {
        if (str2.indexOf(file.excerpt.trim()) === -1) {
          buf += newline(file.excerpt) + newline(close);
        }
      }
      return buf + newline(str2);
    };
    function newline(str2) {
      return str2.slice(-1) !== "\n" ? str2 + "\n" : str2;
    }
  }
});

// node_modules/gray-matter/lib/excerpt.js
var require_excerpt = __commonJS({
  "node_modules/gray-matter/lib/excerpt.js"(exports2, module2) {
    "use strict";
    var defaults = require_defaults();
    module2.exports = function(file, options2) {
      const opts = defaults(options2);
      if (file.data == null) {
        file.data = {};
      }
      if (typeof opts.excerpt === "function") {
        return opts.excerpt(file, opts);
      }
      const sep2 = file.data.excerpt_separator || opts.excerpt_separator;
      if (sep2 == null && (opts.excerpt === false || opts.excerpt == null)) {
        return file;
      }
      const delimiter = typeof opts.excerpt === "string" ? opts.excerpt : sep2 || opts.delimiters[0];
      const idx = file.content.indexOf(delimiter);
      if (idx !== -1) {
        file.excerpt = file.content.slice(0, idx);
      }
      return file;
    };
  }
});

// node_modules/gray-matter/lib/to-file.js
var require_to_file = __commonJS({
  "node_modules/gray-matter/lib/to-file.js"(exports2, module2) {
    "use strict";
    var typeOf = require_kind_of();
    var stringify = require_stringify();
    var utils = require_utils();
    module2.exports = function(file) {
      if (typeOf(file) !== "object") {
        file = { content: file };
      }
      if (typeOf(file.data) !== "object") {
        file.data = {};
      }
      if (file.contents && file.content == null) {
        file.content = file.contents;
      }
      utils.define(file, "orig", utils.toBuffer(file.content));
      utils.define(file, "language", file.language || "");
      utils.define(file, "matter", file.matter || "");
      utils.define(file, "stringify", function(data, options2) {
        if (options2 && options2.language) {
          file.language = options2.language;
        }
        return stringify(file, data, options2);
      });
      file.content = utils.toString(file.content);
      file.isEmpty = false;
      file.excerpt = "";
      return file;
    };
  }
});

// node_modules/gray-matter/lib/parse.js
var require_parse = __commonJS({
  "node_modules/gray-matter/lib/parse.js"(exports2, module2) {
    "use strict";
    var getEngine = require_engine();
    var defaults = require_defaults();
    module2.exports = function(language, str2, options2) {
      const opts = defaults(options2);
      const engine = getEngine(language, opts);
      if (typeof engine.parse !== "function") {
        throw new TypeError('expected "' + language + '.parse" to be a function');
      }
      return engine.parse(str2, opts);
    };
  }
});

// node_modules/gray-matter/index.js
var require_gray_matter = __commonJS({
  "node_modules/gray-matter/index.js"(exports2, module2) {
    "use strict";
    var fs2 = require("fs");
    var sections = require_section_matter();
    var defaults = require_defaults();
    var stringify = require_stringify();
    var excerpt = require_excerpt();
    var engines2 = require_engines();
    var toFile = require_to_file();
    var parse2 = require_parse();
    var utils = require_utils();
    function matter2(input, options2) {
      if (input === "") {
        return { data: {}, content: input, excerpt: "", orig: input };
      }
      let file = toFile(input);
      const cached = matter2.cache[file.content];
      if (!options2) {
        if (cached) {
          file = Object.assign({}, cached);
          file.orig = cached.orig;
          return file;
        }
        matter2.cache[file.content] = file;
      }
      return parseMatter(file, options2);
    }
    function parseMatter(file, options2) {
      const opts = defaults(options2);
      const open = opts.delimiters[0];
      const close = "\n" + opts.delimiters[1];
      let str2 = file.content;
      if (opts.language) {
        file.language = opts.language;
      }
      const openLen = open.length;
      if (!utils.startsWith(str2, open, openLen)) {
        excerpt(file, opts);
        return file;
      }
      if (str2.charAt(openLen) === open.slice(-1)) {
        return file;
      }
      str2 = str2.slice(openLen);
      const len = str2.length;
      const language = matter2.language(str2, opts);
      if (language.name) {
        file.language = language.name;
        str2 = str2.slice(language.raw.length);
      }
      let closeIndex = str2.indexOf(close);
      if (closeIndex === -1) {
        closeIndex = len;
      }
      file.matter = str2.slice(0, closeIndex);
      const block = file.matter.replace(/^\s*#[^\n]+/gm, "").trim();
      if (block === "") {
        file.isEmpty = true;
        file.empty = file.content;
        file.data = {};
      } else {
        file.data = parse2(file.language, file.matter, opts);
      }
      if (closeIndex === len) {
        file.content = "";
      } else {
        file.content = str2.slice(closeIndex + close.length);
        if (file.content[0] === "\r") {
          file.content = file.content.slice(1);
        }
        if (file.content[0] === "\n") {
          file.content = file.content.slice(1);
        }
      }
      excerpt(file, opts);
      if (opts.sections === true || typeof opts.section === "function") {
        sections(file, opts.section);
      }
      return file;
    }
    matter2.engines = engines2;
    matter2.stringify = function(file, data, options2) {
      if (typeof file === "string") file = matter2(file, options2);
      return stringify(file, data, options2);
    };
    matter2.read = function(filepath, options2) {
      const str2 = fs2.readFileSync(filepath, "utf8");
      const file = matter2(str2, options2);
      file.path = filepath;
      return file;
    };
    matter2.test = function(str2, options2) {
      return utils.startsWith(str2, defaults(options2).delimiters[0]);
    };
    matter2.language = function(str2, options2) {
      const opts = defaults(options2);
      const open = opts.delimiters[0];
      if (matter2.test(str2)) {
        str2 = str2.slice(open.length);
      }
      const language = str2.slice(0, str2.search(/\r?\n/));
      return {
        raw: language,
        name: language ? language.trim() : ""
      };
    };
    matter2.cache = {};
    matter2.clearCache = function() {
      matter2.cache = {};
    };
    module2.exports = matter2;
  }
});

// src/tasks/sqlite-task-service.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"));

// src/tasks/repositories/schema.ts
function initSchema(db) {
  createCoreTables(db);
  runLegacyMigrations(db);
  createM1Tables(db);
  createIndexes(db);
}
function createCoreTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS phases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      position INTEGER DEFAULT 0,
      target_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      phase_id TEXT,
      title TEXT NOT NULL,
      priority TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      feature_id TEXT,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'TODO',
      priority TEXT,
      labels TEXT,
      due_date TEXT,
      pinned INTEGER DEFAULT 0,
      file_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      item_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (item_id, tag)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, type)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
function runLegacyMigrations(db) {
  try {
    db.exec("ALTER TABLE phases ADD COLUMN start_date TEXT");
  } catch {
  }
  try {
    db.exec("ALTER TABLE phases ADD COLUMN completed_date TEXT");
  } catch {
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN feature_id TEXT");
  } catch {
  }
  try {
    db.exec(`
      UPDATE tasks SET feature_id = (
        SELECT e.feature_id FROM epics e WHERE e.id = tasks.epic_id
      ) WHERE epic_id IS NOT NULL AND feature_id IS NULL
    `);
  } catch {
  }
  db.exec("DROP TABLE IF EXISTS epics");
  db.exec("DROP TABLE IF EXISTS task_dependencies");
  try {
    db.exec("DROP INDEX IF EXISTS idx_tasks_epic");
  } catch {
  }
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
  } catch {
  }
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN decided_at TEXT");
  } catch {
  }
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_id TEXT");
  } catch {
  }
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN task_id TEXT");
  } catch {
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN phase_id TEXT");
  } catch {
  }
  migrateConversationMessages(db);
}
function migrateConversationMessages(db) {
  const cols = db.pragma("table_info(conversation_messages)");
  const colNames = cols.map((c) => c.name);
  if (colNames.includes("author") && !colNames.includes("author_name")) {
    db.exec("ALTER TABLE conversation_messages RENAME COLUMN author TO author_name");
  }
  if (!colNames.includes("metadata_json")) {
    try {
      db.exec("ALTER TABLE conversation_messages ADD COLUMN metadata_json TEXT");
    } catch {
    }
  }
}
function createM1Tables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      handoff_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL,
      decision_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      closed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      participant_type TEXT NOT NULL,
      participant_role TEXT,
      PRIMARY KEY (conversation_id, participant_name),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'comment',
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_links (
      conversation_id TEXT NOT NULL,
      linked_type TEXT NOT NULL,
      linked_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, linked_type, linked_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_actions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      assignee TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      linked_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);
}
function createIndexes(db) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_features_phase ON features(phase_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tags_item ON tags(item_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(project_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_context_sources_project ON context_sources(project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id)"
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_conv_links_conv ON conversation_links(conversation_id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON conversation_participants(conversation_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_conv_actions_conv ON conversation_actions(conversation_id)"
  );
}

// src/tasks/repositories/project-repository.ts
var ProjectRepository = class {
  constructor(db) {
    this.db = db;
  }
  ensure(id, name, cwd) {
    this.db.prepare("INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)").run(id, name, cwd);
  }
  get(id) {
    const row = this.db.prepare("SELECT id, name, cwd FROM projects WHERE id = ?").get(id);
    return row ?? null;
  }
  list() {
    return this.db.prepare("SELECT id, name, cwd FROM projects ORDER BY name").all();
  }
  addWorkspace(projectId, id, label, cwd) {
    this.db.prepare(
      "INSERT OR REPLACE INTO workspaces (id, project_id, label, cwd) VALUES (?, ?, ?, ?)"
    ).run(id, projectId, label, cwd);
    return { id, projectId, label, cwd };
  }
  getWorkspace(id) {
    const row = this.db.prepare(
      "SELECT id, project_id, label, cwd FROM workspaces WHERE id = ?"
    ).get(id);
    if (!row) return null;
    return { id: row.id, projectId: row.project_id, label: row.label, cwd: row.cwd };
  }
  findWorkspaces(projectId) {
    const rows = this.db.prepare(
      "SELECT id, project_id, label, cwd FROM workspaces WHERE project_id = ? ORDER BY label"
    ).all(projectId);
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      label: r.label,
      cwd: r.cwd
    }));
  }
};

// src/tasks/repositories/shared.ts
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var idCounter = 0;
function generateId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}
function derivedProgress(total, done, inProgress) {
  const status = total === 0 ? "planned" : done === total ? "completed" : done > 0 || inProgress > 0 ? "active" : "planned";
  const percent = total === 0 ? 0 : Math.round(done / total * 100);
  return { total, done, inProgress, status, percent };
}

// src/tasks/repositories/task-repository.ts
function rowToTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id || null,
    parentTaskId: row.parent_task_id || null,
    title: row.title,
    status: row.status,
    priority: row.priority || null,
    labels: row.labels ? JSON.parse(row.labels) : [],
    dueDate: row.due_date || null,
    pinned: row.pinned === 1,
    filePath: row.file_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
var TaskRepository = class {
  constructor(db, relationships) {
    this.db = db;
    this.relationships = relationships;
  }
  nextTaskId(projectId) {
    const rows = this.db.prepare(
      "SELECT id FROM tasks WHERE project_id = ? AND id GLOB 'TASK-[0-9]*'"
    ).all(projectId);
    let max = 0;
    for (const { id } of rows) {
      const n = parseInt(id.slice(5), 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return `TASK-${String(max + 1).padStart(3, "0")}`;
  }
  create(input) {
    const ts = now();
    const id = input.id || this.nextTaskId(input.projectId);
    this.db.prepare(
      `INSERT INTO tasks (id, project_id, phase_id, parent_task_id, title, status, priority, labels, due_date, file_path, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      input.projectId,
      input.phaseId || null,
      input.parentTaskId || null,
      input.title,
      input.status || "TODO",
      input.priority || null,
      input.labels ? JSON.stringify(input.labels) : null,
      input.dueDate || null,
      input.filePath || null,
      ts,
      ts
    );
    return this.get(id);
  }
  update(id, input) {
    const sets = ["updated_at = ?"];
    const params = [now()];
    if (input.title !== void 0) {
      sets.push("title = ?");
      params.push(input.title);
    }
    if (input.status !== void 0) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.priority !== void 0) {
      sets.push("priority = ?");
      params.push(input.priority);
    }
    if (input.phaseId !== void 0) {
      sets.push("phase_id = ?");
      params.push(input.phaseId);
    }
    if (input.parentTaskId !== void 0) {
      sets.push("parent_task_id = ?");
      params.push(input.parentTaskId);
    }
    if (input.labels !== void 0) {
      sets.push("labels = ?");
      params.push(JSON.stringify(input.labels));
    }
    if (input.dueDate !== void 0) {
      sets.push("due_date = ?");
      params.push(input.dueDate);
    }
    if (input.pinned !== void 0) {
      sets.push("pinned = ?");
      params.push(input.pinned ? 1 : 0);
    }
    if (input.filePath !== void 0) {
      sets.push("file_path = ?");
      params.push(input.filePath);
    }
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const task = this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
  delete(id) {
    this.db.prepare("DELETE FROM relationships WHERE from_id = ? OR to_id = ?").run(id, id);
    this.db.prepare("DELETE FROM tags WHERE item_id = ?").run(id);
    this.db.prepare("UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? rowToTask(row) : null;
  }
  find(filter) {
    const { sql, params } = buildTaskQuery(filter);
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(rowToTask);
  }
  getSubtasks(parentId) {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at").all(parentId);
    return rows.map(rowToTask);
  }
  getPinned() {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE pinned = 1 ORDER BY project_id, created_at").all();
    return rows.map(rowToTask);
  }
  getDue(date) {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE due_date <= ? AND status != 'DONE' ORDER BY due_date").all(date);
    return rows.map(rowToTask);
  }
  // Dependencies backed by the relationships table
  addDependency(sourceId, targetId) {
    this.relationships.add(sourceId, targetId, "DEPENDS_ON");
  }
  removeDependency(sourceId, targetId) {
    this.relationships.remove(sourceId, targetId, "DEPENDS_ON");
  }
  getDependencies(taskId) {
    const rows = this.db.prepare(
      "SELECT from_id, to_id FROM relationships WHERE (from_id = ? OR to_id = ?) AND type = 'DEPENDS_ON'"
    ).all(taskId, taskId);
    return rows.map((row) => ({ sourceId: row.from_id, targetId: row.to_id }));
  }
};
function buildTaskQuery(filter) {
  const wheres = [];
  const params = [];
  if (filter.projectId) {
    wheres.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.status) {
    wheres.push("status = ?");
    params.push(filter.status);
  }
  if (filter.priority) {
    wheres.push("priority = ?");
    params.push(filter.priority);
  }
  if (filter.phaseId) {
    wheres.push("phase_id = ?");
    params.push(filter.phaseId);
  }
  if (filter.parentTaskId) {
    wheres.push("parent_task_id = ?");
    params.push(filter.parentTaskId);
  }
  if (filter.pinned) {
    wheres.push("pinned = 1");
  }
  if (filter.dueBefore) {
    wheres.push("due_date <= ?");
    params.push(filter.dueBefore);
  }
  if (filter.query) {
    wheres.push("title LIKE ?");
    params.push(`%${filter.query}%`);
  }
  const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = filter.limit ? `LIMIT ${filter.limit}` : "";
  return { sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC ${limit}`, params };
}

// src/tasks/repositories/phase-repository.ts
function rowToPhase(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    position: row.position || 0,
    startDate: row.start_date || null,
    completedDate: row.completed_date || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
var PhaseRepository = class {
  constructor(db) {
    this.db = db;
  }
  create(input) {
    const ts = now();
    const id = input.id || generateId("PHASE");
    this.db.prepare(
      "INSERT INTO phases (id, project_id, title, status, position, start_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, input.projectId, input.title, input.status || "open", input.position || 0, input.startDate || null, ts, ts);
    return this.get(id);
  }
  update(id, input) {
    const sets = ["updated_at = ?"];
    const params = [now()];
    if (input.title !== void 0) {
      sets.push("title = ?");
      params.push(input.title);
    }
    if (input.status !== void 0) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.position !== void 0) {
      sets.push("position = ?");
      params.push(input.position);
    }
    if (input.startDate !== void 0) {
      sets.push("start_date = ?");
      params.push(input.startDate);
    }
    if (input.completedDate !== void 0) {
      sets.push("completed_date = ?");
      params.push(input.completedDate);
    }
    params.push(id);
    this.db.prepare(`UPDATE phases SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const phase = this.get(id);
    if (!phase) throw new Error(`Phase not found: ${id}`);
    return phase;
  }
  delete(id) {
    this.db.prepare("UPDATE features SET phase_id = NULL WHERE phase_id = ?").run(id);
    this.db.prepare("UPDATE tasks SET phase_id = NULL WHERE phase_id = ?").run(id);
    this.db.prepare("DELETE FROM phases WHERE id = ?").run(id);
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM phases WHERE id = ?").get(id);
    return row ? rowToPhase(row) : null;
  }
  findByProject(projectId) {
    const rows = this.db.prepare("SELECT * FROM phases WHERE project_id = ? ORDER BY position").all(projectId);
    return rows.map(rowToPhase);
  }
  getProgress(phaseId) {
    const phase = this.get(phaseId);
    const row = this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN t.status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks t
       WHERE t.phase_id = ?`
    ).get(phaseId);
    const total = row?.total || 0;
    const done = row?.done || 0;
    const inProgress = row?.ip || 0;
    const percent = total === 0 ? 0 : Math.round(done / total * 100);
    const status = this.deriveProgressStatus(phase, total, done);
    return { total, done, inProgress, status, percent };
  }
  deriveProgressStatus(phase, total, done) {
    if (total > 0 && done === total) {
      if (phase && !phase.completedDate) {
        this.update(phase.id, { completedDate: now().split("T")[0] });
      }
      return "completed";
    }
    if (phase?.startDate) {
      if (phase.completedDate) {
        this.update(phase.id, { completedDate: null });
      }
      return "active";
    }
    return "planned";
  }
};

// src/tasks/repositories/feature-repository.ts
function rowToFeature(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id || null,
    title: row.title,
    priority: row.priority || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
var FeatureRepository = class {
  constructor(db) {
    this.db = db;
  }
  create(input) {
    const ts = now();
    const id = input.id || generateId("FEAT");
    this.db.prepare(
      "INSERT INTO features (id, project_id, phase_id, title, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, input.projectId, input.phaseId || null, input.title, input.priority || null, ts, ts);
    return this.get(id);
  }
  update(id, input) {
    const sets = ["updated_at = ?"];
    const params = [now()];
    if (input.title !== void 0) {
      sets.push("title = ?");
      params.push(input.title);
    }
    if (input.phaseId !== void 0) {
      sets.push("phase_id = ?");
      params.push(input.phaseId);
    }
    if (input.priority !== void 0) {
      sets.push("priority = ?");
      params.push(input.priority);
    }
    params.push(id);
    this.db.prepare(`UPDATE features SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const feature = this.get(id);
    if (!feature) throw new Error(`Feature not found: ${id}`);
    return feature;
  }
  delete(id) {
    this.db.prepare("UPDATE tasks SET feature_id = NULL WHERE feature_id = ?").run(id);
    this.db.prepare("DELETE FROM features WHERE id = ?").run(id);
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM features WHERE id = ?").get(id);
    return row ? rowToFeature(row) : null;
  }
  findByProject(projectId) {
    const rows = this.db.prepare("SELECT * FROM features WHERE project_id = ? ORDER BY created_at").all(projectId);
    return rows.map(rowToFeature);
  }
  findByPhase(phaseId) {
    const rows = this.db.prepare("SELECT * FROM features WHERE phase_id = ? ORDER BY created_at").all(phaseId);
    return rows.map(rowToFeature);
  }
  getProgress(featureId) {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks WHERE feature_id = ?`
    ).get(featureId);
    if (!row) return derivedProgress(0, 0, 0);
    return derivedProgress(row.total || 0, row.done || 0, row.ip || 0);
  }
};

// src/tasks/repositories/document-repository.ts
function rowToDocument(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    filePath: row.file_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
var DocumentRepository = class {
  constructor(db) {
    this.db = db;
  }
  create(input) {
    const ts = now();
    const id = input.id || generateId("DOC");
    this.db.prepare(
      "INSERT INTO documents (id, project_id, type, title, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, input.projectId, input.type, input.title, input.filePath || null, ts, ts);
    return this.get(id);
  }
  update(id, input) {
    const sets = ["updated_at = ?"];
    const params = [now()];
    if (input.title !== void 0) {
      sets.push("title = ?");
      params.push(input.title);
    }
    if (input.type !== void 0) {
      sets.push("type = ?");
      params.push(input.type);
    }
    if (input.filePath !== void 0) {
      sets.push("file_path = ?");
      params.push(input.filePath);
    }
    params.push(id);
    this.db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const doc = this.get(id);
    if (!doc) throw new Error(`Document not found: ${id}`);
    return doc;
  }
  delete(id) {
    this.db.prepare("DELETE FROM tags WHERE item_id = ?").run(id);
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    return row ? rowToDocument(row) : null;
  }
  findByProject(projectId, type) {
    const rows = type ? this.db.prepare("SELECT * FROM documents WHERE project_id = ? AND type = ? ORDER BY created_at").all(projectId, type) : this.db.prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY type, created_at").all(projectId);
    return rows.map(rowToDocument);
  }
};

// src/tasks/repositories/tag-repository.ts
var TagRepository = class {
  constructor(db) {
    this.db = db;
  }
  add(itemId, tag) {
    this.db.prepare("INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)").run(itemId, tag);
  }
  remove(itemId, tag) {
    this.db.prepare("DELETE FROM tags WHERE item_id = ? AND tag = ?").run(itemId, tag);
  }
  getForItem(itemId) {
    const rows = this.db.prepare("SELECT tag FROM tags WHERE item_id = ? ORDER BY tag").all(itemId);
    return rows.map((row) => row.tag);
  }
  findItemsByTag(tag) {
    const rows = this.db.prepare("SELECT item_id FROM tags WHERE tag = ? ORDER BY item_id").all(tag);
    return rows.map((row) => row.item_id);
  }
};

// src/tasks/repositories/relationship-repository.ts
function rowToRelationship(row) {
  return { fromId: row.from_id, toId: row.to_id, type: row.type };
}
var RelationshipRepository = class {
  constructor(db) {
    this.db = db;
  }
  add(fromId, toId, type) {
    this.db.prepare("INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, ?)").run(fromId, toId, type);
  }
  remove(fromId, toId, type) {
    this.db.prepare("DELETE FROM relationships WHERE from_id = ? AND to_id = ? AND type = ?").run(fromId, toId, type);
  }
  getForItem(itemId) {
    const rows = this.db.prepare(
      "SELECT * FROM relationships WHERE from_id = ? OR to_id = ?"
    ).all(itemId, itemId);
    return rows.map(rowToRelationship);
  }
  getFrom(itemId, type) {
    const rows = type ? this.db.prepare("SELECT * FROM relationships WHERE from_id = ? AND type = ?").all(itemId, type) : this.db.prepare("SELECT * FROM relationships WHERE from_id = ?").all(itemId);
    return rows.map(rowToRelationship);
  }
};

// src/tasks/repositories/session-repository.ts
function rowToSession(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id || null,
    taskId: row.task_id || null,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    status: row.status,
    handoff: row.handoff_json ? JSON.parse(row.handoff_json) : null,
    createdAt: row.created_at
  };
}
var SessionRepository = class {
  constructor(db) {
    this.db = db;
  }
  create(input) {
    const ts = now();
    const id = input.id || generateId("SESSION");
    const startedAt = input.startedAt || ts;
    this.db.prepare(
      `INSERT INTO sessions (id, project_id, workspace_id, task_id, started_at, status, handoff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      input.workspaceId || null,
      input.taskId || null,
      startedAt,
      input.status || "active",
      input.handoff ? JSON.stringify(input.handoff) : null,
      ts
    );
    return this.get(id);
  }
  update(id, input) {
    const sets = [];
    const params = [];
    if (input.endedAt !== void 0) {
      sets.push("ended_at = ?");
      params.push(input.endedAt);
    }
    if (input.status !== void 0) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.taskId !== void 0) {
      sets.push("task_id = ?");
      params.push(input.taskId);
    }
    if (input.handoff !== void 0) {
      sets.push("handoff_json = ?");
      params.push(input.handoff === null ? null : JSON.stringify(input.handoff));
    }
    if (sets.length === 0) {
      const s2 = this.get(id);
      if (!s2) throw new Error(`Session not found: ${id}`);
      return s2;
    }
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const s = this.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    return s;
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? rowToSession(row) : null;
  }
  findByProject(projectId, status) {
    const rows = status ? this.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND status = ? ORDER BY started_at DESC").all(projectId, status) : this.db.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC").all(projectId);
    return rows.map(rowToSession);
  }
  getActive(projectId, workspaceId) {
    const sql = workspaceId ? "SELECT * FROM sessions WHERE project_id = ? AND workspace_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1" : "SELECT * FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1";
    const params = workspaceId ? [projectId, workspaceId] : [projectId];
    const row = this.db.prepare(sql).get(...params);
    return row ? rowToSession(row) : null;
  }
  delete(id) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
};

// src/tasks/repositories/context-source-repository.ts
function rowToContextSource(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type,
    sourcePath: row.source_path,
    label: row.label,
    category: row.category,
    priority: row.priority,
    isActive: row.is_active === 1
  };
}
var ContextSourceRepository = class {
  constructor(db) {
    this.db = db;
  }
  create(input) {
    const id = input.id || generateId("CTXSRC");
    this.db.prepare(
      `INSERT INTO context_sources (id, project_id, source_type, source_path, label, category, priority, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      input.sourceType,
      input.sourcePath,
      input.label,
      input.category,
      input.priority ?? 100,
      input.isActive === false ? 0 : 1
    );
    return this.get(id);
  }
  update(id, input) {
    const sets = [];
    const params = [];
    if (input.sourceType !== void 0) {
      sets.push("source_type = ?");
      params.push(input.sourceType);
    }
    if (input.sourcePath !== void 0) {
      sets.push("source_path = ?");
      params.push(input.sourcePath);
    }
    if (input.label !== void 0) {
      sets.push("label = ?");
      params.push(input.label);
    }
    if (input.category !== void 0) {
      sets.push("category = ?");
      params.push(input.category);
    }
    if (input.priority !== void 0) {
      sets.push("priority = ?");
      params.push(input.priority);
    }
    if (input.isActive !== void 0) {
      sets.push("is_active = ?");
      params.push(input.isActive ? 1 : 0);
    }
    if (sets.length === 0) {
      const s2 = this.get(id);
      if (!s2) throw new Error(`ContextSource not found: ${id}`);
      return s2;
    }
    params.push(id);
    this.db.prepare(`UPDATE context_sources SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const s = this.get(id);
    if (!s) throw new Error(`ContextSource not found: ${id}`);
    return s;
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM context_sources WHERE id = ?").get(id);
    return row ? rowToContextSource(row) : null;
  }
  findByProject(projectId, activeOnly = false) {
    const sql = activeOnly ? "SELECT * FROM context_sources WHERE project_id = ? AND is_active = 1 ORDER BY priority, label" : "SELECT * FROM context_sources WHERE project_id = ? ORDER BY priority, label";
    const rows = this.db.prepare(sql).all(projectId);
    return rows.map(rowToContextSource);
  }
  delete(id) {
    this.db.prepare("DELETE FROM context_sources WHERE id = ?").run(id);
  }
};

// src/tasks/repositories/conversation-repository.ts
function rowToConversation(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdBy: row.created_by,
    decisionSummary: row.decision_summary || null,
    createdAt: row.created_at,
    decidedAt: row.decided_at || null,
    closedAt: row.closed_at || null
  };
}
function rowToParticipant(row) {
  return {
    conversationId: row.conversation_id,
    name: row.participant_name,
    type: row.participant_type,
    role: row.participant_role || null
  };
}
function rowToMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorName: row.author_name,
    content: row.content,
    messageType: row.message_type,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    createdAt: row.created_at
  };
}
function rowToAction(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    assignee: row.assignee,
    description: row.description,
    status: row.status,
    linkedTaskId: row.linked_task_id || null,
    createdAt: row.created_at
  };
}
var ConversationRepository = class {
  constructor(db) {
    this.db = db;
  }
  // ── Conversations ──────────────────────────────────────────────────────────
  create(input) {
    const id = input.id || generateId("CONV");
    this.db.prepare(
      `INSERT INTO conversations (id, project_id, title, status, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, input.projectId, input.title, input.status || "open", input.createdBy);
    if (input.participants) {
      for (const p of input.participants) {
        this.addParticipant(id, p.name, p.type, p.role);
      }
    }
    return this.get(id);
  }
  update(id, input) {
    const sets = [];
    const params = [];
    if (input.title !== void 0) {
      sets.push("title = ?");
      params.push(input.title);
    }
    if (input.status !== void 0) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.decisionSummary !== void 0) {
      sets.push("decision_summary = ?");
      params.push(input.decisionSummary);
    }
    if (input.decidedAt !== void 0) {
      sets.push("decided_at = ?");
      params.push(input.decidedAt);
    }
    if (input.closedAt !== void 0) {
      sets.push("closed_at = ?");
      params.push(input.closedAt);
    }
    if (sets.length === 0) return this.requireGet(id);
    params.push(id);
    this.db.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.requireGet(id);
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? rowToConversation(row) : null;
  }
  findByProject(projectId, status) {
    const rows = status ? this.db.prepare("SELECT * FROM conversations WHERE project_id = ? AND status = ? ORDER BY created_at DESC").all(projectId, status) : this.db.prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
    return rows.map(rowToConversation);
  }
  delete(id) {
    this.db.prepare("DELETE FROM conversation_actions WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_links WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_participants WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }
  requireGet(id) {
    const c = this.get(id);
    if (!c) throw new Error(`Conversation not found: ${id}`);
    return c;
  }
  // ── Participants ───────────────────────────────────────────────────────────
  addParticipant(conversationId, name, type, role) {
    this.db.prepare(
      `INSERT OR REPLACE INTO conversation_participants
       (conversation_id, participant_name, participant_type, participant_role)
       VALUES (?, ?, ?, ?)`
    ).run(conversationId, name, type, role ?? null);
  }
  removeParticipant(conversationId, name) {
    this.db.prepare(
      "DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_name = ?"
    ).run(conversationId, name);
  }
  getParticipants(conversationId) {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_participants WHERE conversation_id = ? ORDER BY participant_name"
    ).all(conversationId);
    return rows.map(rowToParticipant);
  }
  // ── Messages ───────────────────────────────────────────────────────────────
  addMessage(input) {
    const id = input.id || generateId("MSG");
    this.db.prepare(
      `INSERT INTO conversation_messages
       (id, conversation_id, author_name, content, message_type, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.conversationId,
      input.authorName,
      input.content,
      input.messageType || "comment",
      input.metadata ? JSON.stringify(input.metadata) : null
    );
    const row = this.db.prepare("SELECT * FROM conversation_messages WHERE id = ?").get(id);
    return rowToMessage(row);
  }
  getMessages(conversationId) {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id"
    ).all(conversationId);
    return rows.map(rowToMessage);
  }
  // ── Actions ────────────────────────────────────────────────────────────────
  addAction(input) {
    const id = input.id || generateId("ACT");
    this.db.prepare(
      `INSERT INTO conversation_actions
       (id, conversation_id, assignee, description, status, linked_task_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.conversationId,
      input.assignee,
      input.description,
      input.status || "pending",
      input.linkedTaskId || null
    );
    const row = this.db.prepare("SELECT * FROM conversation_actions WHERE id = ?").get(id);
    return rowToAction(row);
  }
  updateAction(id, input) {
    const sets = [];
    const params = [];
    if (input.status !== void 0) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.linkedTaskId !== void 0) {
      sets.push("linked_task_id = ?");
      params.push(input.linkedTaskId);
    }
    if (sets.length > 0) {
      params.push(id);
      this.db.prepare(`UPDATE conversation_actions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }
    const row = this.db.prepare("SELECT * FROM conversation_actions WHERE id = ?").get(id);
    if (!row) throw new Error(`ConversationAction not found: ${id}`);
    return rowToAction(row);
  }
  getActions(conversationId) {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_actions WHERE conversation_id = ? ORDER BY created_at, id"
    ).all(conversationId);
    return rows.map(rowToAction);
  }
  // ── Links ──────────────────────────────────────────────────────────────────
  link(conversationId, linkedType, linkedId) {
    this.db.prepare(
      "INSERT OR IGNORE INTO conversation_links (conversation_id, linked_type, linked_id) VALUES (?, ?, ?)"
    ).run(conversationId, linkedType, linkedId);
  }
  unlink(conversationId, linkedType, linkedId) {
    this.db.prepare(
      "DELETE FROM conversation_links WHERE conversation_id = ? AND linked_type = ? AND linked_id = ?"
    ).run(conversationId, linkedType, linkedId);
  }
  getLinks(conversationId) {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_links WHERE conversation_id = ?"
    ).all(conversationId);
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      linkedType: r.linked_type,
      linkedId: r.linked_id
    }));
  }
  findByLink(linkedType, linkedId) {
    const rows = this.db.prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_links l ON l.conversation_id = c.id
       WHERE l.linked_type = ? AND l.linked_id = ?
       ORDER BY c.created_at DESC`
    ).all(linkedType, linkedId);
    return rows.map(rowToConversation);
  }
};

// src/tasks/sqlite-task-service.ts
var SqliteTaskService = class {
  db;
  projects;
  tasks;
  phases;
  features;
  documents;
  tagsRepo;
  relationships;
  sessions;
  contextSources;
  conversations;
  constructor(dbPath) {
    this.db = new import_better_sqlite3.default(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    initSchema(this.db);
    this.projects = new ProjectRepository(this.db);
    this.relationships = new RelationshipRepository(this.db);
    this.tasks = new TaskRepository(this.db, this.relationships);
    this.phases = new PhaseRepository(this.db);
    this.features = new FeatureRepository(this.db);
    this.documents = new DocumentRepository(this.db);
    this.tagsRepo = new TagRepository(this.db);
    this.sessions = new SessionRepository(this.db);
    this.contextSources = new ContextSourceRepository(this.db);
    this.conversations = new ConversationRepository(this.db);
  }
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  initialize() {
  }
  async initializeAsync() {
  }
  close() {
    this.db.close();
  }
  ensureProject(id, name, cwd) {
    this.projects.ensure(id, name, cwd);
  }
  getProject(id) {
    return this.projects.get(id);
  }
  listProjects() {
    return this.projects.list();
  }
  addWorkspace(projectId, id, label, cwd) {
    return this.projects.addWorkspace(projectId, id, label, cwd);
  }
  getWorkspace(id) {
    return this.projects.getWorkspace(id);
  }
  findWorkspaces(projectId) {
    return this.projects.findWorkspaces(projectId);
  }
  // ── Task operations ────────────────────────────────────────────────────────
  createTask(input) {
    return this.tasks.create(input);
  }
  updateTask(id, input) {
    return this.tasks.update(id, input);
  }
  deleteTask(id) {
    this.tasks.delete(id);
  }
  getTask(id) {
    return this.tasks.get(id);
  }
  findTasks(filter) {
    return this.tasks.find(filter);
  }
  getSubtasks(parentId) {
    return this.tasks.getSubtasks(parentId);
  }
  getPinnedTasks() {
    return this.tasks.getPinned();
  }
  getDueTasks(date) {
    return this.tasks.getDue(date);
  }
  addDependency(sourceId, targetId) {
    this.tasks.addDependency(sourceId, targetId);
  }
  removeDependency(sourceId, targetId) {
    this.tasks.removeDependency(sourceId, targetId);
  }
  getDependencies(taskId) {
    return this.tasks.getDependencies(taskId);
  }
  // ── Phase operations ───────────────────────────────────────────────────────
  createPhase(input) {
    return this.phases.create(input);
  }
  updatePhase(id, input) {
    return this.phases.update(id, input);
  }
  deletePhase(id) {
    this.phases.delete(id);
  }
  getPhase(id) {
    return this.phases.get(id);
  }
  findPhases(projectId) {
    return this.phases.findByProject(projectId);
  }
  getPhaseProgress(phaseId) {
    return this.phases.getProgress(phaseId);
  }
  // ── Feature operations ─────────────────────────────────────────────────────
  createFeature(input) {
    return this.features.create(input);
  }
  updateFeature(id, input) {
    return this.features.update(id, input);
  }
  deleteFeature(id) {
    this.features.delete(id);
  }
  getFeature(id) {
    return this.features.get(id);
  }
  findFeatures(projectId) {
    return this.features.findByProject(projectId);
  }
  findFeaturesByPhase(phaseId) {
    return this.features.findByPhase(phaseId);
  }
  getFeatureProgress(featureId) {
    return this.features.getProgress(featureId);
  }
  // ── Document operations ────────────────────────────────────────────────────
  createDocument(input) {
    return this.documents.create(input);
  }
  updateDocument(id, input) {
    return this.documents.update(id, input);
  }
  deleteDocument(id) {
    this.documents.delete(id);
  }
  getDocument(id) {
    return this.documents.get(id);
  }
  findDocuments(projectId, type) {
    return this.documents.findByProject(projectId, type);
  }
  // ── Tags ───────────────────────────────────────────────────────────────────
  addTag(itemId, tag) {
    this.tagsRepo.add(itemId, tag);
  }
  removeTag(itemId, tag) {
    this.tagsRepo.remove(itemId, tag);
  }
  getTags(itemId) {
    return this.tagsRepo.getForItem(itemId);
  }
  findByTag(tag) {
    return this.tagsRepo.findItemsByTag(tag);
  }
  // ── Relationships ──────────────────────────────────────────────────────────
  addRelationship(fromId, toId, type) {
    this.relationships.add(fromId, toId, type);
  }
  removeRelationship(fromId, toId, type) {
    this.relationships.remove(fromId, toId, type);
  }
  getRelationships(itemId) {
    return this.relationships.getForItem(itemId);
  }
  getRelationshipsFrom(itemId, type) {
    return this.relationships.getFrom(itemId, type);
  }
  // ── Session operations (M1) ────────────────────────────────────────────────
  createSession(input) {
    return this.sessions.create(input);
  }
  updateSession(id, input) {
    return this.sessions.update(id, input);
  }
  getSession(id) {
    return this.sessions.get(id);
  }
  findSessions(projectId, status) {
    return this.sessions.findByProject(projectId, status);
  }
  getActiveSession(projectId, workspaceId) {
    return this.sessions.getActive(projectId, workspaceId);
  }
  deleteSession(id) {
    this.sessions.delete(id);
  }
  // ── Context source operations (M1) ─────────────────────────────────────────
  createContextSource(input) {
    return this.contextSources.create(input);
  }
  updateContextSource(id, input) {
    return this.contextSources.update(id, input);
  }
  getContextSource(id) {
    return this.contextSources.get(id);
  }
  findContextSources(projectId, activeOnly = false) {
    return this.contextSources.findByProject(projectId, activeOnly);
  }
  deleteContextSource(id) {
    this.contextSources.delete(id);
  }
  // ── Conversation operations (M1) ───────────────────────────────────────────
  createConversation(input) {
    return this.conversations.create(input);
  }
  updateConversation(id, input) {
    return this.conversations.update(id, input);
  }
  getConversation(id) {
    return this.conversations.get(id);
  }
  findConversations(projectId, status) {
    return this.conversations.findByProject(projectId, status);
  }
  deleteConversation(id) {
    this.conversations.delete(id);
  }
  addConversationParticipant(conversationId, name, type, role) {
    this.conversations.addParticipant(conversationId, name, type, role);
  }
  removeConversationParticipant(conversationId, name) {
    this.conversations.removeParticipant(conversationId, name);
  }
  getConversationParticipants(conversationId) {
    return this.conversations.getParticipants(conversationId);
  }
  addConversationMessage(input) {
    return this.conversations.addMessage(input);
  }
  getConversationMessages(conversationId) {
    return this.conversations.getMessages(conversationId);
  }
  addConversationAction(input) {
    return this.conversations.addAction(input);
  }
  updateConversationAction(id, input) {
    return this.conversations.updateAction(id, input);
  }
  getConversationActions(conversationId) {
    return this.conversations.getActions(conversationId);
  }
  linkConversation(conversationId, linkedType, linkedId) {
    this.conversations.link(conversationId, linkedType, linkedId);
  }
  unlinkConversation(conversationId, linkedType, linkedId) {
    this.conversations.unlink(conversationId, linkedType, linkedId);
  }
  getConversationLinks(conversationId) {
    return this.conversations.getLinks(conversationId);
  }
  findConversationsByLink(linkedType, linkedId) {
    return this.conversations.findByLink(linkedType, linkedId);
  }
};

// src/tasks/vault-importer.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_gray_matter = __toESM(require_gray_matter());
var chokidar = __toESM(require("chokidar"));
var DEFAULT_STATUS_MAP = {
  todo: "TODO",
  open: "TODO",
  ready: "READY",
  "in-progress": "IN-PROGRESS",
  "in progress": "IN-PROGRESS",
  doing: "IN-PROGRESS",
  done: "DONE",
  closed: "DONE"
};
function normalizeStatus(raw, statusMap) {
  if (!raw) return "TODO";
  return statusMap[raw.toLowerCase()] || "TODO";
}
function normalizePriority(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (["critical", "high", "medium", "low"].includes(lower)) return lower;
  return null;
}
function extractId(filename, prefixes) {
  const base = path.basename(filename, ".md");
  const part = base.split("_")[0];
  const valid = new RegExp(`^(?:${prefixes.join("|")})-`);
  return valid.test(part) ? part : null;
}
function normalizeList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string")
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
function projectDir(contentRoot, projectId) {
  return path.join(contentRoot, "10-Projects", projectId);
}
function tasksDir(contentRoot, projectId) {
  return path.join(projectDir(contentRoot, projectId), "tasks");
}
function phasesDir(contentRoot, projectId) {
  return path.join(projectDir(contentRoot, projectId), "phases");
}
function docsDir(contentRoot, projectId) {
  return path.join(projectDir(contentRoot, projectId), "docs");
}
function archiveDir(contentRoot, projectId) {
  return path.join(contentRoot, "90-Archive", projectId);
}
function fileExists(contentRoot, relPath) {
  return fs.existsSync(path.join(contentRoot, relPath));
}
function recentDecisionFiles(contentRoot, relDir, limit) {
  const abs = path.join(contentRoot, relDir);
  if (!fs.existsSync(abs)) return [];
  const entries = fs.readdirSync(abs).filter((f) => f.endsWith(".md")).map((f) => {
    const full = path.join(abs, f);
    return { rel: `${relDir}/${f}`, mtime: fs.statSync(full).mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  return entries.map((e) => e.rel);
}
function decisionLabel(relPath) {
  const base = path.basename(relPath, ".md");
  return base.replace(/[_-]+/g, " ");
}
function emptyResult() {
  return {
    tasks: 0,
    phases: 0,
    documents: 0,
    conversations: 0,
    sessions: 0,
    tags: 0,
    relationships: 0,
    skipped: 0,
    errors: []
  };
}
var VaultImporter = class {
  taskService;
  contentRoot;
  statusMap;
  watcher = null;
  constructor(taskService, contentRoot, statusMap) {
    this.taskService = taskService;
    this.contentRoot = contentRoot;
    this.statusMap = { ...DEFAULT_STATUS_MAP, ...statusMap || {} };
  }
  /**
   * Full import: scan all project folders, import tasks, phases, documents
   */
  importAll(projectIds) {
    const result2 = emptyResult();
    for (const projectId of projectIds) {
      this.taskService.ensureProject(projectId, projectId, projectDir(this.contentRoot, projectId));
      this.ensureDefaultContextSources(projectId);
      this.importTasks(projectId, result2);
      this.importArchive(projectId, result2);
      this.reconcileTaskFilePaths(projectId);
      this.importPhases(projectId, result2);
      this.importDocuments(projectId, result2);
      this.importConversations(projectId, result2);
      this.importHandoff(projectId, result2);
    }
    return result2;
  }
  // ── Default context sources ────────────────────────────────────────────
  ensureDefaultContextSources(projectId) {
    const existing = new Set(
      this.taskService.findContextSources(projectId).map((s) => s.sourcePath)
    );
    const candidates = this.defaultContextSourceCandidates(projectId);
    for (const c of candidates) {
      if (existing.has(c.sourcePath)) continue;
      this.taskService.createContextSource({
        projectId,
        sourceType: "file",
        sourcePath: c.sourcePath,
        label: c.label,
        category: c.category,
        priority: c.priority
      });
    }
  }
  defaultContextSourceCandidates(projectId) {
    const out = [];
    const base = `10-Projects/${projectId}`;
    if (fileExists(this.contentRoot, `${base}/context.md`)) {
      out.push({
        label: "System Overview",
        sourcePath: `${base}/context.md`,
        category: "what",
        priority: 10
      });
    }
    if (fileExists(this.contentRoot, `${base}/handoff.md`)) {
      out.push({
        label: "Current Handoff",
        sourcePath: `${base}/handoff.md`,
        category: "state",
        priority: 5
      });
    }
    const archCandidates = [
      `${base}/docs/architecture.md`,
      `${base}/workflow-engine/docs/architecture.md`
    ];
    const arch = archCandidates.find((p) => fileExists(this.contentRoot, p));
    if (arch) out.push({ label: "Architecture", sourcePath: arch, category: "how", priority: 20 });
    for (const sub of this.discoverSubDirs(base)) {
      const ctxPath = `${base}/${sub}/context.md`;
      if (fileExists(this.contentRoot, ctxPath)) {
        out.push({ label: `${sub} Context`, sourcePath: ctxPath, category: "how", priority: 25 });
      }
    }
    const feStandards = `${base}/remote-workflow/docs/standards/fe-standards.md`;
    if (fileExists(this.contentRoot, feStandards)) {
      out.push({ label: "FE Standards", sourcePath: feStandards, category: "how", priority: 30 });
    }
    const decisionDirs = [
      `${base}/docs/decisions`,
      `${base}/workflow-engine/docs/decisions`,
      `${base}/remote-workflow/docs/decisions`
    ];
    for (const dir of decisionDirs) {
      for (const rel of recentDecisionFiles(this.contentRoot, dir, 3)) {
        out.push({
          label: decisionLabel(rel),
          sourcePath: rel,
          category: "decisions",
          priority: 35
        });
      }
    }
    const featDir = path.join(this.contentRoot, base, "features");
    if (fs.existsSync(featDir)) {
      const feats = fs.readdirSync(featDir).filter((f) => f.endsWith(".md")).slice(0, 5);
      for (const f of feats) {
        const rel = `${base}/features/${f}`;
        out.push({
          label: `Feature: ${f.replace(".md", "").replace(/[-_]/g, " ")}`,
          sourcePath: rel,
          category: "what",
          priority: 40
        });
      }
    }
    return out;
  }
  discoverSubDirs(base) {
    const abs = path.join(this.contentRoot, base);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "tasks" && d.name !== "phases" && d.name !== "docs" && d.name !== "features"
    ).map((d) => d.name);
  }
  // ── Task import ─────────────────────────────────────────────────────────
  importTasks(projectId, result2) {
    const dir = tasksDir(this.contentRoot, projectId);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        if (this.importTaskFile(path.join(dir, file), projectId, result2)) result2.tasks++;
        else result2.skipped++;
      } catch (err) {
        result2.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  importArchive(projectId, result2) {
    const dir = archiveDir(this.contentRoot, projectId);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const taskId = extractId(file, ["TASK", "BUG"]);
      if (!taskId) continue;
      try {
        if (this.importTaskFile(path.join(dir, file), projectId, result2, true)) result2.tasks++;
        else result2.skipped++;
      } catch (err) {
        result2.errors.push(`archive/${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  importTaskFile(filePath, projectId, result2, archived = false) {
    const filename = path.basename(filePath);
    const taskId = extractId(filename, ["TASK", "BUG"]);
    if (!taskId) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    let parsed;
    try {
      parsed = (0, import_gray_matter.default)(content);
    } catch {
      return false;
    }
    const fm = parsed.data;
    if (!fm || Object.keys(fm).length === 0) return false;
    const status = archived ? "DONE" : normalizeStatus(fm.status, this.statusMap);
    const priority = normalizePriority(fm.priority);
    const title = fm.title || taskId;
    const phaseRef = fm.phase ? String(fm.phase) : null;
    const phaseId = phaseRef ? this.taskService.getPhase(phaseRef) ? phaseRef : void 0 : void 0;
    const existing = this.taskService.getTask(taskId);
    if (existing) {
      this.taskService.updateTask(taskId, {
        title,
        status,
        priority,
        labels: fm.labels || void 0,
        filePath,
        ...phaseId !== void 0 ? { phaseId } : {}
      });
    } else {
      this.taskService.createTask({
        id: taskId,
        projectId,
        title,
        status,
        priority: priority || void 0,
        labels: fm.labels,
        filePath,
        phaseId
      });
    }
    const tags = normalizeList(fm.tags);
    for (const tag of tags) {
      this.taskService.addTag(taskId, tag);
      result2.tags++;
    }
    this.importRelationships(taskId, fm, result2);
    return true;
  }
  reconcileTaskFilePaths(projectId) {
    const tasks = this.taskService.findTasks({ projectId });
    for (const task of tasks) {
      if (task.filePath && !fs.existsSync(task.filePath)) {
        this.taskService.updateTask(task.id, { filePath: null });
      }
    }
  }
  // ── Phase import ────────────────────────────────────────────────────────
  importPhases(projectId, result2) {
    const dir = phasesDir(this.contentRoot, projectId);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        if (this.importPhaseFile(path.join(dir, file), projectId, result2)) result2.phases++;
        else result2.skipped++;
      } catch (err) {
        result2.errors.push(`phase/${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  importPhaseFile(filePath, projectId, result2) {
    const content = fs.readFileSync(filePath, "utf-8");
    let parsed;
    try {
      parsed = (0, import_gray_matter.default)(content);
    } catch {
      return false;
    }
    const fm = parsed.data;
    if (!fm || !fm.id) return false;
    const id = fm.id;
    const title = fm.title || id;
    const status = fm.status === "closed" ? "closed" : "open";
    const position = typeof fm.position === "number" ? fm.position : 0;
    const startDate = fm.startDate || fm["start-date"] || null;
    const existing = this.taskService.getPhase(id);
    if (existing) {
      this.taskService.updatePhase(id, { title, status, position, startDate });
    } else {
      this.taskService.createPhase({
        id,
        projectId,
        title,
        status,
        position,
        startDate: startDate || void 0
      });
    }
    const tags = normalizeList(fm.tags);
    for (const tag of tags) {
      this.taskService.addTag(id, tag);
      result2.tags++;
    }
    return true;
  }
  // ── Document import ─────────────────────────────────────────────────────
  importDocuments(projectId, result2) {
    const dir = docsDir(this.contentRoot, projectId);
    if (!fs.existsSync(dir)) return;
    const decisionsDir = path.join(dir, "decisions");
    if (fs.existsSync(decisionsDir)) {
      this.importDocDir(decisionsDir, projectId, "adr", result2);
    }
    const rootFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of rootFiles) {
      try {
        if (this.importDocFile(path.join(dir, file), projectId, "spec", result2)) result2.documents++;
        else result2.skipped++;
      } catch (err) {
        result2.errors.push(`docs/${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  importDocDir(dir, projectId, type, result2) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        if (this.importDocFile(path.join(dir, file), projectId, type, result2)) result2.documents++;
        else result2.skipped++;
      } catch (err) {
        result2.errors.push(`docs/${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  importDocFile(filePath, projectId, defaultType, result2) {
    const content = fs.readFileSync(filePath, "utf-8");
    let parsed;
    try {
      parsed = (0, import_gray_matter.default)(content);
    } catch {
      return false;
    }
    const fm = parsed.data;
    const filename = path.basename(filePath, ".md");
    const id = fm.id || filename;
    const title = fm.title || filename;
    const type = fm.type || defaultType;
    const existing = this.taskService.getDocument(id);
    if (existing) {
      this.taskService.updateDocument(id, { title, type, filePath });
    } else {
      this.taskService.createDocument({ id, projectId, type, title, filePath });
    }
    const tags = normalizeList(fm.tags);
    for (const tag of tags) {
      this.taskService.addTag(id, tag);
      result2.tags++;
    }
    return true;
  }
  // ── Conversation import ─────────────────────────────────────────────────
  importConversations(projectId, result2) {
    const filePath = path.join(projectDir(this.contentRoot, projectId), "conversation.md");
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf-8");
    const threads = parseConversationThreads(content);
    for (const thread of threads) {
      try {
        const existing = this.taskService.findConversations(projectId).find((c) => c.title === thread.title);
        if (existing) continue;
        const status = thread.closed ? "decided" : "open";
        const conv = this.taskService.createConversation({
          projectId,
          title: thread.title,
          createdBy: thread.author,
          status,
          participants: thread.participants.map((p) => ({ name: p, type: "role" }))
        });
        if (thread.closed) {
          this.taskService.updateConversation(conv.id, {
            status: "decided",
            closedAt: thread.date
          });
        }
        for (const msg of thread.messages) {
          this.taskService.addConversationMessage({
            conversationId: conv.id,
            authorName: msg.author,
            content: msg.content,
            messageType: msg.type
          });
        }
        result2.conversations++;
      } catch (err) {
        result2.errors.push(
          `conversation #${thread.number}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  // ── Handoff import ─────────────────────────────────────────────────────
  importHandoff(projectId, result2) {
    const filePath = path.join(projectDir(this.contentRoot, projectId), "handoff.md");
    if (!fs.existsSync(filePath)) return;
    const existing = this.taskService.findSessions(projectId, "completed");
    if (existing.length > 0) return;
    const content = fs.readFileSync(filePath, "utf-8");
    const handoff = parseHandoffFile(content);
    if (!handoff) return;
    try {
      const session = this.taskService.createSession({
        projectId,
        startedAt: handoff.date,
        status: "completed",
        handoff: {
          commits: handoff.commits,
          decisions: handoff.decisions,
          resumePoint: handoff.resumePoint,
          looseEnds: handoff.looseEnds
        }
      });
      this.taskService.updateSession(session.id, { endedAt: handoff.date });
      result2.sessions++;
    } catch (err) {
      result2.errors.push(`handoff: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ── Relationships from frontmatter ──────────────────────────────────────
  importRelationships(itemId, fm, result2) {
    const mapping = [
      { key: "depends-on", type: "DEPENDS_ON" },
      { key: "implements", type: "IMPLEMENTS" },
      { key: "uses-tech", type: "USES_TECH" },
      { key: "decided-by", type: "DECIDED_BY" }
    ];
    for (const { key, type } of mapping) {
      const targets = normalizeList(fm[key]);
      for (const target of targets) {
        this.taskService.addRelationship(itemId, target, type);
        result2.relationships++;
      }
    }
  }
  // ── File watcher ────────────────────────────────────────────────────────
  startWatching(projectIds) {
    const watchPaths = projectIds.flatMap((id) => [
      tasksDir(this.contentRoot, id),
      phasesDir(this.contentRoot, id),
      docsDir(this.contentRoot, id),
      archiveDir(this.contentRoot, id)
    ]).filter((p) => fs.existsSync(p));
    if (watchPaths.length === 0) return;
    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });
    this.watcher.on("change", (filePath) => this.handleFileChange(filePath));
    this.watcher.on("add", (filePath) => this.handleFileChange(filePath));
  }
  handleFileChange(filePath) {
    if (!filePath.endsWith(".md")) return;
    const relative2 = path.relative(this.contentRoot, filePath);
    const parts = relative2.split(path.sep);
    let projectId = null;
    let archived = false;
    if (parts[0] === "10-Projects" && parts.length >= 4) {
      projectId = parts[1];
    } else if (parts[0] === "90-Archive" && parts.length >= 3) {
      projectId = parts[1];
      archived = true;
    }
    if (!projectId) return;
    const result2 = emptyResult();
    try {
      const subdir = parts[2];
      if (subdir === "tasks" || archived) {
        this.importTaskFile(filePath, projectId, result2, archived);
      } else if (subdir === "phases") {
        this.importPhaseFile(filePath, projectId, result2);
      } else if (subdir === "docs") {
        const type = parts[3] === "decisions" ? "adr" : "spec";
        this.importDocFile(filePath, projectId, type, result2);
      }
    } catch {
    }
  }
  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
};
var THREAD_HEADER_RE = /^## #(\d+)\s+(.+?)(?:\s+—\s+(CLOSED|OPEN))?\s*$/;
function parseConversationThreads(content) {
  const lines = content.split("\n");
  const threads = [];
  let current = null;
  let msgLines = [];
  let currentAuthor = "";
  let currentType = "question";
  function flushMessage() {
    if (!current || msgLines.length === 0) return;
    const text = msgLines.join("\n").trim();
    if (text) {
      current.messages.push({ author: currentAuthor, content: text, type: currentType });
    }
    msgLines = [];
  }
  for (const line of lines) {
    const headerMatch = line.match(THREAD_HEADER_RE);
    if (headerMatch) {
      flushMessage();
      current = {
        number: parseInt(headerMatch[1]),
        title: headerMatch[2].trim(),
        closed: headerMatch[3] === "CLOSED",
        date: "",
        author: "",
        participants: [],
        messages: []
      };
      threads.push(current);
      currentAuthor = "";
      currentType = "question";
      continue;
    }
    if (!current) continue;
    const dateMatch = line.match(/^\*\*Date:\*\*\s*(.+)/);
    if (dateMatch) {
      current.date = dateMatch[1].trim();
      continue;
    }
    const toMatch = line.match(/^\*\*To:\*\*\s*(.+)/);
    if (toMatch) {
      current.participants = toMatch[1].split(",").map((s) => s.trim());
      continue;
    }
    const replyMatch = line.match(
      /^\*\*(\w[\w\s]*?)\s+reply\s*—\s*[\d-]+(?:\s*—\s*CLOSED)?:\*\*\s*$/
    );
    if (replyMatch) {
      flushMessage();
      currentAuthor = replyMatch[1].trim();
      currentType = "answer";
      if (!current.participants.includes(currentAuthor)) {
        current.participants.push(currentAuthor);
      }
      continue;
    }
    const ctxMatch = line.match(/^\*\*Context:\*\*\s*(.*)/);
    if (ctxMatch) {
      flushMessage();
      currentAuthor = current.participants[0] || "author";
      currentType = "question";
      msgLines.push(ctxMatch[1]);
      continue;
    }
    if (line.trim() === "---") {
      flushMessage();
      continue;
    }
    msgLines.push(line);
  }
  flushMessage();
  return threads;
}
function parseHandoffFile(content) {
  let parsed;
  try {
    parsed = (0, import_gray_matter.default)(content);
  } catch {
    return null;
  }
  const raw = parsed.data.date;
  const date = raw instanceof Date ? raw.toISOString().slice(0, 10) : raw ? String(raw).slice(0, 10) : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const body = parsed.content;
  const sections = splitSections(body);
  return {
    date,
    commits: extractBullets(sections["what was done"] || sections["what was accomplished"] || ""),
    decisions: extractBullets(sections["decisions made"] || sections["decisions"] || ""),
    resumePoint: (sections["resume point"] || sections["open / next"] || "").trim(),
    looseEnds: extractBullets(sections["loose ends"] || sections["blockers"] || "")
  };
}
function splitSections(body) {
  const result2 = {};
  const parts = body.split(/^## /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const nlIdx = part.indexOf("\n");
    if (nlIdx === -1) continue;
    const heading = part.slice(0, nlIdx).trim().toLowerCase();
    result2[heading] = part.slice(nlIdx + 1);
  }
  return result2;
}
function extractBullets(text) {
  return text.split("\n").filter((l) => /^\s*[-*]\s/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
}

// scripts/_import-ts.ts
var DB_PATH = process.env.CHODA_DB_PATH || "C:\\dev\\choda-deck\\choda-deck.db";
var CONTENT_ROOT = process.env.CHODA_CONTENT_ROOT || "C:\\Users\\hngo1_mantu\\vault";
var projects = (process.argv[2] || "automation-rule").split(",");
var svc = new SqliteTaskService(DB_PATH);
var importer = new VaultImporter(svc, CONTENT_ROOT);
var result = importer.importAll(projects);
console.log(JSON.stringify(result, null, 2));
svc.close();
/*! Bundled license information:

is-extendable/index.js:
  (*!
   * is-extendable <https://github.com/jonschlinkert/is-extendable>
   *
   * Copyright (c) 2015, Jon Schlinkert.
   * Licensed under the MIT License.
   *)

strip-bom-string/index.js:
  (*!
   * strip-bom-string <https://github.com/jonschlinkert/strip-bom-string>
   *
   * Copyright (c) 2015, 2017, Jon Schlinkert.
   * Released under the MIT License.
   *)
*/

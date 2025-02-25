// An `apostrophe-cursor` allows you to conveniently fetch docs from
// the `aposDocs` mongodb collection using chainable filters, much
// like a MongoDB or Doctrine cursor.
//
// Usually you'll be working with a subclass of `apostrophe-cursor`
// appropriate to a particular type of piece or page. Each subclass
// typically adds new filters. Some modules also add filters to the
// main `apostrophe-cursor` class that are useful with all types
// of docs, like the `areas` filter that calls loaders for
// the widgets in Apostrophe areas.
//
// Normally you get a cursor object by calling the `find()` method of
// the module associated with the piece type or page type you are
// interested in. If you are interested in all docs, call the
// `find()` method of the `apostrophe-docs` module (`apos.docs.find`).
// If you are interested in all pages (docs that are part of the
// page tree), call the `find()` method of the `apostrophe-pages`
// module (`apos.pages.find`).
//
// All of these `find()` methods take `req` as the first argument
// in order to check permissions.
//
// Examples:
//
// Let's fetch all docs with an `age` property >= 30 that are published...
//
// ```
// return apos.docs.find(req).
//   and({ age: { $gte: 30 } }).
//   published(true).
//   toArray(function(err, docs) { ... });
// ```
//
// Let's get the 10 most recent blog posts (assumes the
// `apostrophe-blog` module is in use)
//
// ```
// return apos.docs.getManager('apostrophe-blog').
//   find().
//   limit(10).
//   toArray(function(err, blogPosts) { ... })
// ```
//
// If a filter provides a `launder` function and sets its
// `safeFor` property to `public`, then it is called
// automatically if a query parameter matching its name is seen
// on an `apostrophe-pieces-pages` page, such as a blog. In many
// cases this is the main motivation for adding a filter.

var _ = require('lodash');
var async = require('async');
var util = require('util');

// Helpful to find missing setImmediate callbacks
// var superSetImmediate = setImmediate;
// setImmediate = function(fn) {
//   if (!fn) {
//     console.trace();
//     process.exit(1);
//   }
//   return superSetImmediate(fn);
// }

module.exports = {

  // We are not a module, do not use the
  // default base class
  extend: false,

  beforeConstruct: function(self, options) {
    self.options = options;
    self.apos = options.apos;
    self.db = self.apos.docs.db;
  },

  afterConstruct: function(self) {
    self.handleFindArguments();
  },

  construct: function(self, options) {

    self.state = {};
    self.filters = {};
    self.finalizers = {};
    self.afters = {};

    // Add a new filter method to this cursor.
    //
    // `name` is the filter method name. `definition` is an
    // object which can  have `set`, `finalize` and `after`
    // functions and a default value, `def`. You provide
    // this functionality and Apostrophe builds the
    // actual chainable method for you.
    //
    // A filter may also have a `launder` function. If present
    // it is expected to clean up data passed by an end user and
    // return the cleaned-up value. It must not trust the data
    // in any way (hint: use `self.apos.launder.string`, etc).
    // If you also set `safeFor: 'public'`, the filter then becomes
    // available as a query string parameter in `apostrophe-pieces-pages`
    // and other modules that invoke `queryToFilters`.
    //
    // `set` defaults to a simple `self.set` call
    // to store its single argument for retrieval
    // by `self.get('nameOfFilter')`. `finalize` defaults
    // to doing nothing. Usually your finalizer
    // modifies the criteria in some way, most often
    // by calling the `self.and(obj)` filter to
    // add new conditions to the criteria built
    // up so far.
    //
    // Your finalizer must be idempotent — That is,
    // it must not be harmful to invoke it twice.
    // If it is harmful, just use self.set to
    // undefine your state so your code doesn't
    // run twice.
    //
    // If the filter has still not been called at
    // finalization time, the filter is called
    // with `def` before the finalizer is invoked.
    //
    // `finalize` may optionally take a callback.
    // So can `after`.
    //
    // If `finalize` returns the string `refinalize`
    // or delivers that string to its callback, the
    // entire series of finalizers is invoked
    // again. This is useful if you wish to simplify
    // the query and be assured that all of the other
    // finalizers will see your modification.

    self.addFilter = function(name, definition) {
      definition = definition || {};
      var set = definition.set || function(value) {
        self.set(name, value);
      };
      self[name] = function() {
        if (self._finalized) {
          throw new Error('The cursor has already been finalized, refusing to add ' + name + ' filter. To add more filters, clone this filter: cursor.clone()');
        }
        set.apply(self, arguments);
        return self;
      };
      var finalize = definition.finalize || function() {
      };
      self.finalizers[name] = function(callback) {
        var value = self.get(name);
        if (value === undefined) {
          self[name](definition.def);
        }
        if (finalize.length === 1) {
          return finalize(callback);
        }
        try {
          var returned = finalize();
          return setImmediate(_.partial(callback, null, returned));
        } catch (e) {
          return setImmediate(_.partial(callback, null, e));
        }
      };

      var after = definition.after || function() {
      };
      self.afters[name] = function(results, callback) {
        var value = self.get(name);
        if (value === undefined) {
          self[name](definition.def);
        }
        if (after.length === 2) {
          return after(results, callback);
        }
        try {
          after(results);
          return setImmediate(_.partial(callback, null, results));
        } catch (e) {
          return setImmediate(_.partial(callback, e));
        }
      };

      self.filters[name] = definition;
    };

    // Filter. Sets the MongoDB criteria, discarding
    // criteria previously added using this
    // method or the `and` method. For this reason,
    // `and` is a more common choice. You can also
    // pass a criteria object as the second argument
    // to any `find` method.

    self.addFilter('criteria', { def: {} });
    
    // Filter. Provides an object to be merged directly into the final
    // criteria object that will go to MongoDB. This is to be used only
    // in cases where MongoDB forbids the use of an operator inside
    // `$and`, such as the `$near` operator.
    
    self.addFilter('addLateCriteria', {
      set: function(c) {
        var lateCriteria = self.get('lateCriteria');
        if (!lateCriteria) {
          lateCriteria = _.clone(c);
        } else {
          _.assign(lateCriteria, c);
        }
        self.set('lateCriteria', lateCriteria);
      }
    });

    // Filter. Requires all criteria already specified AND
    // the criteria object specified by `c` to match
    // the docs.

    self.addFilter('and', {
      set: function(c) {
        if (!c) {
          // So we don't crash on our default value
          return;
        }
        var criteria = self.get('criteria');
        if (!criteria) {
          self.criteria(c);
        } else {
          self.criteria({
            $and: [ criteria, c ]
          });
        }
      }
    });

    // Filter. Sets the MongoDB projection. You can also
    // set the projection as the third argument to any
    // `find` method.

    self.addFilter('projection', {
      finalize: function() {
        var projection = self.get('projection');
        if (!projection) {
          projection = {};
        }
        if (self.get('search')) {
          // MongoDB mandates this if we want to sort on search result quality
          projection.textScore = { $meta: 'textScore' };
        }
        self.set('projection', projection);
      }
    });
    
    // Filter. Changes the default value for the `sort` filter.
    // The argument is the same as for the `sort` filter: an
    // object like `{ title: 1 }`. `false` can be passed to clear
    // a default.
    //
    // This filter is called by apostrophe-pieces based on its
    // `sort` configuration option.
    //
    // It is distinct from the `sort` filter so that we can
    // distinguish between cases where a default sort should be ignored
    // (for instance, the `search` filter is present) and cases
    // where a sort is explicitly demanded by the user.

    self.addFilter('defaultSort', {});

    // Filter. Sets the MongoDB sort, with some extra features.
    //
    // If `false` is explicitly passed, there is
    // *no sort at all* (helpful with `$near`).
    //
    // If this method is never called or `obj` is
    // undefined, a case-insensitive sort on the title
    // is the default, unless `search()` has been
    // called, in which case a sort by search result
    // quality is the default.
    //
    // If you sort on a field that is defined in the
    // schema for the specific doc type you are finding,
    // and that field has the `sortify: true` option in
    // its schema field definition, then this filter will
    // automatically substitute a "sortified" version of
    // the field that is case-insensitive, ignores
    // extra whitespace and punctuation, etc. for a
    // more natural sort than MongoDB normally provides.
    //
    // For instance, `title` has `sortify: true` for all
    // doc types, so you always get the more natural sort.

    self.addFilter('sort', {

      launder: function(s) {
        if (s === 'search') {
          return s;
        }
        if (typeof(s) !== 'object') {
          return undefined;
        }
        var sort = {};
        _.each(s, function(val, key) {
          if (typeof(key) !== 'string') {
            return;
          }
          if (val === "-1") {
            val = -1;
          } else if (val === "1") {
            val = 1;
          }
          if ((val !== -1) && (val !== 1)) {
            return;
          }
          sort[key] = val;
        });
        return sort;
      },

      finalize: function() {
        // adjust the sort option taking the search
        // option into account, and supplying a default
        // sort unless expressly declined

        var sort = self.get('sort');

        if (sort === false) {
          // OK, you really truly don't want a sort
          // (for instance, you are relying on the
          // implicit sort of $near)
        } else if (self.get('search')) {
          // Text search is in the picture. If they don't
          // specify a sort or specify "sort: 'search'",
          // sort by search result quality. Offer void if
          // we are using regex search
          if (!self.get('regexSearch')) {
            if ((!sort) || (sort === 'search')) {
              sort = { textScore: { $meta: 'textScore' } };
            }
          }
        } else if (!sort) {
          sort = self.get('defaultSort') || { title: 1 };
        }

        // So interested parties can see how the sort
        // ultimately worked out
        self.set('sort', sort);

        // Below here we're making it more mongo-tastic. Don't modify
        // the A2-tastic version, preserve it for inspection
        if (sort) {
          sort = _.cloneDeep(sort);
        }

        if (sort) {

          // SORTIFY BEHAVIOR
          //
          // If a field has "sortify: true" in the schema, automatically
          // fix sort({ title: 1 }) to be sort({ titleSortify: 1 })

          // If a type filter was not used, we're limited to sortified fields that exist
          // for all pages, but that's still useful (title).
          // There's an apostrophe-page "type" that is never really in the database but
          // has a manager thanks to apostrophe-any-page-manager. Use that as a default
          // so that we always get a manager object

          var manager = self.apos.docs.getManager(self.get('type') || 'apostrophe-page');
          if (!(manager && manager.schema)) {
            return setImmediate(callback);
          }

          var sortify = {};
          _.each(manager.schema, function(field) {
            if (field.sortify) {
              sortify[field.name] = true;
            }
          });
          _.each(_.keys(sort), function(key) {
            // automatically switch to sort-friendly versions of properties
            if (_.has(sortify, key)) {
              sort[key + 'Sortified'] = sort[key];
              delete sort[key];
            }
          });

        }

        self.set('sortMongo', sort);
      }
    });

    // Filter. Skip the first n documents. Affects
    // `toArray` and `toObject`. Does not affect
    // `toDistinct` or `toMongo`.

    self.addFilter('skip', {
      launder: function(s) {
        return self.apos.launder.integer(s, 0, 0);
      },
      safeFor: 'public'
    });

    // Filter. Limit to n documents. Affects `toArray` only.

    self.addFilter('limit', {
      launder: function(s) {
        return self.apos.launder.integer(s, 0, 0);
      },
      safeFor: 'public'
    });

    // Filter. Allows you to paginate docs rather than using
    // skip and limit directly.
    //
    // Sets the number of docs per page and enables the
    // use of the `page` filter to indicate the current page.
    //
    // Used by `apostrophe-pieces` and `apostrophe-pieces-pages`.

    self.addFilter('perPage', {
      def: undefined
    });

    // Filter. Sets the current page number. You must also
    // use `perPage`.
    //
    // Used by `apostrophe-pieces` and `apostrophe-pieces-pages`.

    self.addFilter('page', {
      def: 1,
      launder: function(i) {
        return self.apos.launder.integer(i, 1, 1);
      },
      finalize: function() {
        if (self.get('perPage')) {
          var page = self.get('page');
          self.skip((self.get('page') - 1) * self.get('perPage'));
          self.limit(self.get('perPage'));
        }
      },
      safeFor: 'public'
    });

    // Filter limit the returned docs to those for which the
    // user associated with the cursor's `req` has the
    // named permission. By default, `view-doc` is
    // checked for.
    //
    // `edit`, `view` and `publish` are the
    // permissions you're likely to want to restrict
    // results to.
    //
    // USE WITH CARE: If you pass `false`, permissions checks are disabled.
    //
    // If this method is never called, or you pass
    // `undefined` or `null`, `view` is checked for.
    //
    // The permission name is suffixed for you
    // with a specific doc type name if the type filter
    // has been called, however for database queries
    // this normally makes no difference unless the permissions
    // module has been extended.
    //
    // In all cases, all of the returned docs are marked
    // with `_edit: true` and/or `_publish: true` properties
    // if the user associated with the request is allowed to
    // do those things. This is useful if you are fetching
    // docs for viewing but also want to know which ones
    // can be edited.

    self.addFilter('permission', {
      finalize: function() {
        var typeSuffix = '-' + (self.get('type') || 'doc');
        var permission = self.get('permission');
        if (permission !== false) {
          if (permission && (!permission.match(/\-/))) {
            permission = permission + typeSuffix;
          }
          var p = permission || ('view-' + typeSuffix);
          self.and(self.apos.permissions.criteria(self.get('req'), permission || ('view-' + typeSuffix)));
        }
      },
      after: function(results) {
        // In all cases we mark the docs with ._edit and
        // ._publish if the req is allowed to do those things
        self.apos.permissions.annotate(self.get('req'), 'edit-doc', results);
        self.apos.permissions.annotate(self.get('req'), 'publish-doc', results);
      }
    });

    // Filter. Limits results to docs which are a good match for
    // a partial string typed by the user. Appropriate words must
    // exist in the title, tags or other text schema fields of
    // the doc (autocomplete is not full text body search). Those words
    // are then fed back into the `search` filter to prioritize the results.

    self.addFilter('autocomplete', {
      finalize: require('./autocomplete.js')(self),
      safeFor: 'public',
      launder: function(s) {
        return self.apos.launder.string(s);
      }
    });

    // Filter. Limits results to those that match the given search.
    // Search is implemented using MongoDB's `$text` operator and a full
    // text index.
    //
    // If this filter is set, the `sort` filter will default to sorting
    // by search quality. This is important because the worst of the
    // full-text search matches will be of very poor quality.

    self.addFilter('search', {
      finalize: function() {
        // Other finalizers also address other
        // aspects of this, like adjusting
        // projection and sort
        var search = self.get('search');
        if (search) {
          if (self.get('regexSearch')) {
            // A filter like the `geo` filter of apostrophe-places
            // has warned us that `$near` or another operator incompatible
            // with `$text` is present. We must dumb down to regex search
            self.and({
              highSearchText: self.apos.utils.searchify(search)
            });
          } else {
            // Set up MongoDB text index search
            self.and({
              $text: { $search: search }
            });
          }
        }
      },
      safeFor: 'public',
      launder: function(s) {
        return self.apos.launder.string(s);
      }
    });

    // Filter. Limits results to those which include the specified
    // tag in their `tags` property.

    self.addFilter('tag', {
      finalize: function() {
        var tag = self.get('tag');
        if (tag) {
          self.and({
            tags: tag
          });
        }
      },
      safeFor: 'public',
      launder: function(s) {
        return self.apos.launder.string(s);
      }
    });

    // Filter. Limits results to those which include at least one
    // of the specified array of tags in their tags property.

    self.addFilter('tags', {
      finalize: function() {
        var tags = self.get('tags');
        if (tags) {
          self.and({
            tags: { $in: tags }
          });
        }
      },
      safeFor: 'public',
      launder: function(s) {
        if (!Array.isArray(s)) {
          return [];
        }
        return _.map(s, function(value) {
          return self.apos.launder.string(value);
        });
      }
    })

    // Filter. if flag is `false`, `undefined` or this method is
    // never called, return only docs not in the trash. This is
    // the default behavior.
    //
    // if flag is `true`, return only docs in the trash.
    //
    // if flag is `null` (not undefined), return
    // docs regardless of trash status.

    self.addFilter('trash', {
      finalize: function() {
        var trash = self.get('trash');
        if (trash === null) {
          return;
        }
        if (!trash) {
          // allow trash to work as a normal boolean; also treat
          // docs inserted with no trash property at all as not
          // being trash. We can't use $ne: true here because $ne is
          // nonselective (it won't use an index). -Tom
          self.and({
            $or: [
              {
                trash: { $exists: 0 }
              },
              {
                trash: false
              }
            ]
          });
          return;
        }
        self.and({
          trash: true
        });
      },
      safeFor: 'manage',
      launder: function(s) {
        return self.apos.launder.booleanOrNull(s);
      }
    });

    // Filter. If flag is `undefined`, `true` or this
    // method is never called, return only published docs.
    //
    // If flag is `false`, return only unpublished docs.
    //
    // If flag is `null`, return docs without regard
    // to published status.
    //
    // Regardless of this filter the user's permissions are
    // always taken into account. For instance, a logged-out user will never
    // see unpublished documents unless `permissions(false)` is called.

    self.addFilter('published', {
      def: true,
      finalize: function() {
        var published = self.get('published');
        if (published === null) {
          return;
        }
        if (published) {
          self.and({
            published: true
          });
          return;
        }
        self.and({
          published: { $ne: true }
        });
      },
      safeFor: 'manage',
      launder: function(s) {
        return self.apos.launder.booleanOrNull(s);
      }
    });

    // Filter. Pass an array of `_id` values. The returned
    // docs will be in that specific order. If a
    // doc is not mentioned in the array it will
    // be discarded from the result. Docs that
    // exist in the array but not in the database are
    // also absent from the result.
    //
    // You may optionally specify a property name
    // other than `_id` to order the results on as a
    // second argument.

    self.addFilter('explicitOrder', {
      set: function(values, property) {
        self.set('explicitOrder', values);
        self.set('explicitOrderProperty', property);
      }
    });

    // Filter. This cursor will only retrieve documents of the
    // specified type. Filters out everything else.
    //
    // Generally you don't want to call this filter directly.
    // Call the `find()` method of the doc type manager
    // for the type you are interested in. This will also
    // give you a cursor of the right subclass.

    self.addFilter('type', {
      finalize: function() {
        var type = self.get('type');
        if (type) {
          self.and({ type: type });
        }
      }
    });

    // Filter. Performs joins by default, for all types retrieved,
    // based on the schema for each type. If `joins(false)` is
    // explicitly called no joins are performed. If
    // `joins()` is invoked with an array of join names
    // only those joins and those intermediate to them
    // are performed (dot notation). See `apostrophe-schemas`
    // for more information.
    //
    // TODO: identify joins with identical definitions in
    // each schema and pass those "intersection" schemas to
    // self.apos.schemas.join just once, for performance.

    self.addFilter('joins', {
      def: true,
      after: function(results, callback) {
        if (!self.get('joins')) {
          return setImmediate(callback);
        }
        var resultsByType = _.groupBy(results, 'type');
        return async.eachSeries(_.keys(resultsByType), function(type, callback) {
          var manager = self.apos.docs.getManager(type);
          // Careful, there will be no manager if type was not part of the projection
          if (!(manager && manager.schema)) {
            return setImmediate(callback);
          }
          return self.apos.schemas.join(self.get('req'), manager.schema, resultsByType[type], self.get('joins'), callback);
        }, callback);
      }
    });

    // Invokes the `addUrls` method of all doc type managers
    // with relevant docs among the results, if they have one.
    //
    // The method receives `(req, docs, callback)`. All of the docs will be of
    // the appropriate type for that manager.
    //
    // The `addUrls` method should add the `._url` property to each doc,
    // if possible.
    //
    // If it is not possible (there is no corresponding pieces-page)
    // it may be left unset.
    //
    // Defaults to `true`. If set to false, `addUrls` methods are
    // not invoked.

    self.addFilter('addUrls', {
      def: true,
      after: function(results, callback) {
        var req = self.get('req');
        var val = self.get('addUrls');
        if (!val) {
          return setImmediate(callback);
        }
        var byType = _.groupBy(results, 'type');
        var interesting = _.filter(_.keys(byType), function(type) {
          // Don't freak out if the projection was really conservative
          // and the type is unknown, etc.
          var manager = self.apos.docs.getManager(type);
          return manager && manager.addUrls;
        });
        return async.eachSeries(interesting, function(type, callback) {
          return self.apos.docs.getManager(type).addUrls(req, byType[type], callback);
        }, callback);
      }
    });

    // Invokes callback with `(err, results)` where
    // `results` is an array of all distinct values
    // for the given `property`. Not chainable.

    self.toDistinct = function(property, callback) {
      return self.finalize(function(err) {
        if (err) {
          return callback(err);
        }
        return self.db.distinct(property, self.get('criteria'), callback);
      });
    };

    // Invokes callback with `(err, doc)` where
    // `doc` is the first document matching the query.
    // Not chainable.

    self.toObject = function(callback) {
      var limit = self.get('limit');
      self.set('limit', 1);
      return self.toArray(function(err, results) {
        if (err) {
          return callback(err);
        }
        self.set('limit', limit);
        return callback(null, results[0]);
      });
    };

    // Invokes callback with `(err, count)` where
    // `count` is the number of documents matching
    // the query, ignoring the `page`, `skip` and `limit` filters.
    //
    // If the `perPage` filter is set, `totalPages` is
    // made available via `cursor.get('totalPages')`.
    //
    // Not chainable.

    self.toCount = function(callback) {
      var cursor = self.clone();
      cursor.skip(undefined);
      cursor.limit(undefined);
      cursor.page(undefined);
      cursor.perPage(undefined);
      return cursor.toMongo(function(err, mongo) {
        if (err) {
          return callback(err);
        }
        return mongo.count(function(err, count) {
          if (err) {
            return callback(err);
          }
          if (self.get('perPage')) {
            var perPage = self.get('perPage');
            var limit = self.get('limit');
            var totalPages = Math.floor(count / perPage);
            if (count % perPage) {
              totalPages++;
            }
            self.set('totalPages', totalPages);
          }
          return callback(null, count);
        });
      });
    };

    // Invokes callback with `(err, docs)` where
    // `docs` is an array of documents matching
    // the query. Not chainable.

    self.toArray = function(callback) {
      return async.waterfall([
        self.toMongo,
        self.mongoToArray,
        self.after
      ], callback);
    };

    // Invokes callback with `(err, mongo)` where
    // `mongo` is a MongoDB self. You can use this
    // to access MongoDB's `nextObject` method, etc.
    // If you use it, you should also invoke `after`
    // for each result (see below). Generally you should
    // use `toObject`, `toArray`, etc. but for some
    // low-level operations this may be desirable. Not chainable.

    self.toMongo = function(callback) {

      return async.waterfall([
        function(callback) {
          return self.finalize(callback);
        },
        function(callback) {
          var criteria = self.get('criteria');
          var lateCriteria = self.get('lateCriteria');
          if (lateCriteria) {
            _.assign(criteria, lateCriteria);
          }
          // console.log(require('util').inspect(criteria, { depth: 20 }));
          var mongo = self.db.find(self.get('criteria'), self.get('projection'));
          var util = require('util');
          var skip = self.get('skip');
          if (_.isNumber(skip)) {
            mongo.skip(skip);
          }
          var limit = self.get('limit');
          if (_.isNumber(limit)) {
            mongo.limit(limit);
          }
          mongo.sort(self.get('sortMongo'));
          return callback(null, mongo);
        }
      ], callback);
    };

    // Clones a cursor, creating an independent
    // clone that can be modified without modifying
    // the original cursor. This should be called when
    // querying based on the same criteria multiple
    // times. Returns the new cursor.

    self.clone = function() {
      var cursor = self.apos.create(self.__meta.name, options);
      // The cloneDeep operation goes haywire and costs a full half second
      // if we clone the req object, which actually should not diverge
      // anyway, so it's incorrect to clone it. Placing `req` `in `state`
      // was probably a mistake, but it would be a bc break to move it now.
      // -Tom
      var req = self.state.req;
      delete self.state.req;
      cursor.state = _.cloneDeep(self.state);
      cursor.state.req = req;
      self.state.req = req;
      return cursor;
    };

    // Invoked by afterConstruct to handle the arguments that came
    // from the find() call responsible for creating this cursor.

    self.handleFindArguments = function() {
      if (self.options.req) {
        self.set('req', self.options.req);
      }
      if (self.options.criteria) {
        self.set('criteria', self.options.criteria);
      }
      if (self.options.projection) {
        self.set('projection', self.options.projection);
      }
    };

    // Filters and any other methods you add should
    // store their state with this method rather than
    // by directly modifying `self` or `self.state`. The
    // default implementation of the `set` function for
    // each cursor just calls this with the cursor's name
    // and first argument.

    self.set = function(key, value) {
      self.state[key] = value;
      return self;
    };

    // Filters you add to cursors should fetch their
    // state with this method rather than by directly
    // modifying `self` or `self.state`. By default the
    // first argument to the filter is stored under
    // the filter's name.

    self.get = function(key) {
      return self.state[key];
    };

    // Apply filters present in a query object (often from req.query), skipping all
    // filters not declared as safe for the given domain (such as "public" or "manage").
    // Filters declaring themselves as safe must implement a `launder` function to
    // clean up the data. Never trust a browser.
    //
    // If `safeFor` is not specified or is set to `manage`, we assume any filter that
    // has a launder method is suitable for our use.

    self.queryToFilters = function(query, safeFor) {
      _.each(query, function(value, name) {

        if (!_.has(self.filters, name)) {
          return;
        }

        if (!self.filters[name].launder) {
          return;
        }

        if (safeFor && safeFor !== 'manage' && safeFor !== self.filters[name].safeFor) {
          return;
        }

        value = self.filters[name].launder(value);
        self[name](value);

      });

      return self;
    };

    // Apply the named filters present in the given object, WITHOUT checking for safety or
    // laundering the data in any way. ALWAYS use `queryToFilters` instead for anything
    // coming directly from the user.

    self.applyFilters = function(obj) {
      _.each(obj, function(val, name) {
        self[name](val);
      });
      // Chainable method
      return self;
    };

    // Applies all defaults and transformations prior
    // to handing off the query to MongoDB. This is where
    // most filters add criteria, and it is where tricky filters
    // like `autocomplete` make database queries.

    self.finalize = function(callback) {
      // We don't need to finalize twice because we disallow filters to
      // be added after initial finalization.
      if (self._finalized) {
        return callback(null);
      }
      return async.series(_.values(self.finalizers), function(err) {
        if (err) {
          if (err === 'refinalize') {
            return self.finalize(callback);
          }
          return callback(err);
        }
        self._finalized = true;
        return callback(null);
      });
    };

    // An implementation detail of `toArray`, subject to
    // change. You probably wanted toMongo.

    self.mongoToArray = function(mongo, callback) {
      return mongo.toArray(callback, function(err, results) {
        if (err) {
          return callback(err);
        }
        var explicitOrder = self.get('explicitOrder');
        if (explicitOrder) {
          var explicitOrderProperty = self.get('explicitOrderProperty') || '_id';
          var _results = [];
          var byId = {};
          _.each(results, function(result) {
            byId[result[idProperty]] = result;
          });
          _.each(ids, function(_id) {
            if (byId.hasOwnProperty(_id)) {
              _results.push(byId[_id]);
            }
          });
          return callback(null, _results);
        }
      });
    };

    // Invokes "after" methods of all filters
    // that have them. Invoked for you by `toArray`.

    self.after = function(results, callback) {
      // Since afters, in some cases, invoke filters, we have to
      // set self._finalized to false so these invocations don't
      // throw an exception. I worry about what this would do if
      // there was code running in parallel though.
      var originalFinalized = self._finalized;
      self._finalized = false;
      return async.eachSeries(_.values(self.afters), function(fn, callback) {
        return fn(results, callback);
      }, function(err) {
        if (err) {
          return callback(err);
        }
        self._finalized = originalFinalized;
        return callback(null, results);
      });
    };
  }
};

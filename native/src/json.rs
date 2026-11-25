//! Insertion-ordered JSON for records the TypeScript CLI also rewrites, and `JSON.parse`-compatible input.
//!
//! `serde_json::Map` sorts keys in this build, while `JSON.stringify` keeps insertion order and object spreads keep
//! a key where it already was. Lane registry rows are rewritten with exactly those semantics.

use std::borrow::Cow;
use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::Number;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

impl Json {
    pub(crate) fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(fields) => fields.iter().find(|(name, _)| name == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// A string field; absent, null and non-strings are `None`.
    pub(crate) fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Self::as_str)
    }

    pub(crate) const fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text.as_str()),
            _ => None,
        }
    }

    #[cfg(feature = "discord")]
    pub(crate) fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(number) => number.as_f64(),
            _ => None,
        }
    }

    pub(crate) const fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }

    /// JavaScript truthiness of a field (`undefined` is falsy).
    #[cfg(any(test, feature = "discord"))]
    pub(crate) fn truthy(&self, key: &str) -> bool {
        self.get(key).is_some_and(|value| match value {
            Self::Null | Self::Bool(false) => false,
            Self::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
            Self::String(text) => !text.is_empty(),
            _ => true,
        })
    }

    /// `{ ...this, [key]: value }`: an existing key keeps its position, a new key is appended.
    pub(crate) fn set(&mut self, key: &str, value: Self) {
        if let Self::Object(fields) = self {
            let at = fields
                .iter()
                .position(|(name, _)| name == key)
                .unwrap_or(fields.len());
            if at == fields.len() {
                fields.push((key.to_owned(), value));
            } else {
                fields[at].1 = value;
            }
        }
    }

    pub(crate) fn string(text: &str) -> Self {
        Self::String(text.to_owned())
    }

    pub(crate) fn object(fields: Vec<(&str, Self)>) -> Self {
        Self::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    }

    /// `JSON.stringify(value)`.
    pub(crate) fn compact(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// `JSON.stringify(value, null, 1)`.
    #[cfg(any(test, feature = "discord"))]
    pub(crate) fn pretty1(&self) -> String {
        let mut out = Vec::new();
        let mut serializer = serde_json::Serializer::with_formatter(
            &mut out,
            serde_json::ser::PrettyFormatter::with_indent(b" "),
        );
        if self.serialize(&mut serializer).is_err() {
            return String::new();
        }
        String::from_utf8(out).unwrap_or_default()
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(value) => value.serialize(serializer),
            Self::String(value) => serializer.serialize_str(value),
            Self::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Object(fields) => {
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (key, value) in fields {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Json, E> {
        Ok(Json::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Json, E> {
        Number::from_f64(value)
            .map(Json::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Json, E> {
        Ok(Json::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Json, E> {
        Ok(Json::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        let mut object = Json::Object(Vec::new());
        // JSON.parse keeps the first position of a repeated key and its last value.
        while let Some((key, value)) = map.next_entry::<String, Json>()? {
            object.set(&key, value);
        }
        Ok(object)
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}

/// The UTF-16 surrogate a `\uXXXX` escape at `at` names, if it names one.
fn surrogate_at(bytes: &[u8], at: usize) -> Option<u16> {
    let escape = bytes.get(at..at + 6)?;
    if !escape.starts_with(b"\\u") {
        return None;
    }
    let unit = u16::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok()?;
    (0xD800..=0xDFFF).contains(&unit).then_some(unit)
}

/// `bytes` with every unpaired surrogate escape (`"\ud83d"` alone, or a lone `"\udc00"`) replaced by `\ufffd`.
/// `JSON.parse` keeps such a code unit and any UTF-8 consumer then sees U+FFFD; `serde_json` refuses the text.
/// Valid pairs and every other byte are unchanged, and nothing is copied when there is nothing to replace.
fn unpaired_surrogates(bytes: &[u8]) -> Cow<'_, [u8]> {
    let mut out: Option<Vec<u8>> = None;
    let (mut at, mut copied) = (0, 0);
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        match surrogate_at(bytes, at) {
            Some(0xD800..=0xDBFF)
                if matches!(surrogate_at(bytes, at + 6), Some(0xDC00..=0xDFFF)) =>
            {
                at += 12;
            }
            Some(_) => {
                let out = out.get_or_insert_with(|| Vec::with_capacity(bytes.len()));
                out.extend_from_slice(&bytes[copied..at]);
                out.extend_from_slice(b"\\ufffd");
                at += 6;
                copied = at;
            }
            // Any other escape, `\\` included, is two bytes this pass never looks inside.
            None => at += 2,
        }
    }
    out.map_or(Cow::Borrowed(bytes), |mut out| {
        out.extend_from_slice(&bytes[copied..]);
        Cow::Owned(out)
    })
}

/// Parses JSON text as `JSON.parse` admits it, including unpaired surrogate escapes (read as U+FFFD).
pub fn parse_js<T: de::DeserializeOwned>(bytes: &[u8]) -> serde_json::Result<T> {
    serde_json::from_slice(&unpaired_surrogates(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpaired_surrogate_escapes_parse_like_json_parse() {
        let value: serde_json::Value = parse_js(
            br#"{"a":"x\ud83d","b":"\udc00y","c":"\ud83d\ude00","d":"\\ud83d","e":"\ud83d\ud83d"}"#,
        )
        .unwrap();
        assert_eq!(value["a"], "x\u{fffd}");
        assert_eq!(value["b"], "\u{fffd}y");
        assert_eq!(value["c"], "\u{1f600}");
        assert_eq!(value["d"], "\\ud83d");
        assert_eq!(value["e"], "\u{fffd}\u{fffd}");
        assert!(matches!(
            unpaired_surrogates(br#"{"c":"\ud83d\ude00"}"#),
            Cow::Borrowed(_)
        ));
        assert!(serde_json::from_slice::<serde_json::Value>(br#""\ud83d""#).is_err());
    }

    #[test]
    fn keeps_insertion_order_like_json_stringify() {
        let mut lane: Json = serde_json::from_str(
            r#"{"key":"a","thread":"discord:1","history":[],"z":{"b":1,"a":2}}"#,
        )
        .unwrap();
        lane.set("lifecycleEpoch", Json::string("e"));
        lane.set("key", Json::string("a"));
        assert_eq!(
            lane.pretty1(),
            "{\n \"key\": \"a\",\n \"thread\": \"discord:1\",\n \"history\": [],\n \"z\": {\n  \"b\": 1,\n  \"a\": 2\n },\n \"lifecycleEpoch\": \"e\"\n}"
        );
        assert_eq!(
            lane.compact(),
            r#"{"key":"a","thread":"discord:1","history":[],"z":{"b":1,"a":2},"lifecycleEpoch":"e"}"#
        );
    }

    #[test]
    fn truthiness_matches_javascript() {
        let value: Json = serde_json::from_str(r#"{"a":0,"b":"","c":{},"d":null,"e":1}"#).unwrap();
        assert!(!value.truthy("a") && !value.truthy("b") && value.truthy("c"));
        assert!(!value.truthy("d") && value.truthy("e") && !value.truthy("x"));
    }
}

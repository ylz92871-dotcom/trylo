//! Immutable replay identity is independent from team execution authority.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TaggedRecoveryIdentity {
    Conversation {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    Team {
        #[serde(rename = "teamRunId")]
        team_run_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyTeamIdentity {
    team_run_id: String,
    turn_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RecoveryIdentity {
    Tagged(TaggedRecoveryIdentity),
    LegacyTeam(LegacyTeamIdentity),
}

impl RecoveryIdentity {
    pub fn is_team(&self) -> bool {
        !matches!(
            self,
            Self::Tagged(TaggedRecoveryIdentity::Conversation { .. })
        )
    }

    pub fn is_valid(&self) -> bool {
        let (owner, turn) = match self {
            Self::Tagged(TaggedRecoveryIdentity::Conversation { run_id, turn_id }) => {
                (run_id, turn_id)
            }
            Self::Tagged(TaggedRecoveryIdentity::Team {
                team_run_id,
                turn_id,
            })
            | Self::LegacyTeam(LegacyTeamIdentity {
                team_run_id,
                turn_id,
            }) => (team_run_id, turn_id),
        };
        !owner.trim().is_empty() && !turn.trim().is_empty()
    }

    #[cfg(test)]
    pub fn legacy_team(team_run_id: &str, turn_id: &str) -> Self {
        Self::LegacyTeam(LegacyTeamIdentity {
            team_run_id: team_run_id.into(),
            turn_id: turn_id.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_value, json, to_value};

    #[test]
    fn ordinary_replay_ownership_does_not_acquire_team_authority() {
        let wire = json!({ "kind": "conversation", "runId": "run", "turnId": "turn" });
        let identity: RecoveryIdentity = from_value(wire.clone()).unwrap();
        assert!(!identity.is_team());
        assert!(identity.is_valid());
        assert_eq!(to_value(identity).unwrap(), wire);
    }

    #[test]
    fn existing_team_wire_and_explicit_team_wire_remain_team_owned() {
        for wire in [
            json!({ "teamRunId": "team", "turnId": "turn" }),
            json!({ "kind": "team", "teamRunId": "team", "turnId": "turn" }),
        ] {
            let identity: RecoveryIdentity = from_value(wire.clone()).unwrap();
            assert!(identity.is_team());
            assert!(identity.is_valid());
            assert_eq!(to_value(identity).unwrap(), wire);
        }
    }

    #[test]
    fn invalid_and_mixed_ownership_cannot_fall_back_to_a_legacy_team() {
        for wire in [
            json!({ "kind": "unknown", "teamRunId": "team", "turnId": "turn" }),
            json!({ "kind": "conversation", "runId": "run", "teamRunId": "team", "turnId": "turn" }),
            json!({ "kind": "conversation", "turnId": "turn" }),
            json!({ "runId": "run", "turnId": "turn" }),
        ] {
            assert!(from_value::<RecoveryIdentity>(wire).is_err());
        }
        let blank: RecoveryIdentity =
            from_value(json!({ "kind": "conversation", "runId": " ", "turnId": "turn" })).unwrap();
        assert!(!blank.is_valid());
    }
}
